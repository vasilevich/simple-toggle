const test = require('node:test');
const assert = require('node:assert/strict');
const {readFile, MAX_FILE_BYTES} = require('../public/js/value_text');
const ensureStorage = require('../app/value_text_storage');

for (const [name, text] of Object.entries({
    empty: '', whitespace: '  \t\n\n  ', windows: ' first\r\n\tsecond\r\n\r\n',
    mixed: 'one\rtwo\nthree\r\n', unicode: 'שלום\n한글\t😀\n',
    bom: '\ufefffirst\r\n', literals: '<script>alert(1)</script>\n{"a":"b\\n"}\n',
    large: 'x'.repeat(200000), limit: 'x'.repeat(MAX_FILE_BYTES)
})) {
    test(`text file preserves ${name} exactly through JSON`, async () => {
        const result = await readFile(new Blob([text]));
        assert.equal(result, text);
        assert.equal(JSON.parse(JSON.stringify({value: result})).value, text);
    });
}
test('oversized file is rejected before reading', async () => {
    await assert.rejects(readFile({size: MAX_FILE_BYTES + 1, arrayBuffer() { assert.fail('must not read'); }}), /1 MiB/);
});
test('invalid UTF-8 is rejected rather than replaced', async () => {
    await assert.rejects(readFile(new Blob([new Uint8Array([0xc3, 0x28])])), /UTF-8/);
});
test('NUL-containing binary files are rejected', async () => {
    await assert.rejects(readFile(new Blob(['text\0binary'])), /Binary/);
});
test('read failures propagate', async () => {
    await assert.rejects(readFile({size: 1, arrayBuffer: async () => { throw new Error('read failed'); }}), /read failed/);
});
function mockStorage(types) {
    const altered = [];
    const knex = table => {
        assert.equal(table, 'information_schema.COLUMNS');
        let column;
        const query = {
            select() { return query; },
            whereRaw(sql) { assert.equal(sql, 'TABLE_SCHEMA = DATABASE()'); return query; },
            where(filter) { column = `${filter.TABLE_NAME}.${filter.COLUMN_NAME}`; return query; },
            first: async () => types[column] ? {DATA_TYPE: types[column]} : undefined
        };
        return query;
    };
    knex.schema = {alterTable: async (table, callback) => callback({text(name, type) {
        return {alter() { altered.push(`${table}.${name}`); types[`${table}.${name}`] = type; }};
    }})};
    return {knex, altered};
}
test('MySQL and MariaDB upgrade only the three text columns and are idempotent', async () => {
    for (const dialect of ['mysql', 'mysql2', 'mariadb']) {
        const types = {'bot_single_value_control.value': 'text', 'bot_change_history.before_json': 'text', 'bot_change_history.after_json': 'text'};
        const {knex, altered} = mockStorage(types);
        await ensureStorage(knex, dialect);
        assert.deepEqual(altered, Object.keys(types));
        await ensureStorage(knex, dialect);
        assert.equal(altered.length, 3);
    }
});
test('larger existing columns are not shrunk', async () => {
    const {knex, altered} = mockStorage({'bot_single_value_control.value': 'longtext', 'bot_change_history.before_json': 'mediumtext', 'bot_change_history.after_json': 'LONGTEXT'});
    await ensureStorage(knex, 'mysql2');
    assert.deepEqual(altered, []);
});
test('SQLite and PostgreSQL do not run MySQL migrations', async () => {
    for (const dialect of ['sqlite3', 'better-sqlite3', 'pg']) await ensureStorage(() => assert.fail('must not query'), dialect);
});
test('missing column fails explicitly', async () => {
    const {knex} = mockStorage({});
    await assert.rejects(ensureStorage(knex, 'mysql2'), /Missing text column/);
});
