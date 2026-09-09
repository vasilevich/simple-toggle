const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

// Exercise the actual Express route handlers with an in-memory DB/HTTP harness.
// No production service or database is contacted.
async function appHarness() {
    const routes = new Map(), middleware = [], parserOptions = [], snapshots = [];
    const tables = {bot_single_value_control: [], bot_temporary_value_link: []};
    const app = {use(...args) { middleware.push(args); }, on() {}, listen() { assert.fail('must not listen'); }};
    for (const method of ['get', 'post', 'delete']) app[method] = (route, callback) => routes.set(`${method} ${route}`, callback);
    const express = () => app;
    express.static = () => (req, res, next) => next();
    const knex = table => {
        const rows = tables[table] ||= [];
        let filter = () => true;
        const query = {
            where(key, value) { filter = row => row[key] === value; return query; },
            first: async () => rows.find(filter),
            insert: async row => { rows.push({...row}); return 1; },
            update: async update => { let count = 0; for (const row of rows.filter(filter)) { Object.assign(row, update); count++; } return count; },
            del: async () => { const old = rows.length; for (let i = rows.length - 1; i >= 0; i--) if (filter(rows[i])) rows.splice(i, 1); return old - rows.length; }
        };
        return query;
    };
    knex.schema = {hasTable: async () => true};
    knex.transaction = callback => callback(knex);
    const settings = {knex: {client: 'pg'}, token: 'admin', url: 'http://localhost', port: 0, hostname: ''};
    const config = {get: key => settings[key], has: key => key in settings, util: {toObject: () => settings}};
    const modules = {
        config, express, knex: () => knex,
        'body-parser': Object.fromEntries(['json', 'urlencoded'].map(type => [type, options => { parserOptions.push([type, options]); return (req, res, next) => next(); }])),
        cors: () => (req, res, next) => next(),
        'http-proxy-middleware': {createProxyMiddleware: () => () => {}},
        'random-token-generator': {generateKey: (options, callback) => callback(null, 'generated-token')},
        './condition_mapper': () => ({}), './mcp': () => {},
        './history': () => ({schemaReady: Promise.resolve(), record: async (...args) => snapshots.push(structuredClone(args.slice(0, 6)))}),
        './value_text_storage': require('../app/value_text_storage')
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../app/index.js'), 'utf8'), {
        require: name => Object.hasOwn(modules, name) ? modules[name] : require(name), console
    });
    await new Promise(resolve => setImmediate(resolve));
    async function request(method, route, body = {}, params = {}, query = {}, token = 'admin') {
        const req = {body: JSON.parse(JSON.stringify(body)), params, query, headers: {authorization: `Bearer ${token}`}, is: type => type === 'application/json'};
        const result = {status: 200};
        const res = {status(code) { result.status = code; return res; }, set() { return res; }, json(data) { result.data = data; return res; }, send(data) { result.data = data; return res; }};
        await routes.get(`${method} ${route}`)(req, res);
        return result;
    }
    return {request, tables, snapshots, parserOptions};
}
const text = '\ufeff  first\r\n\tשלום 한글 😀\n\r\nlast  \r\n' + 'x'.repeat(200000);
test('create, edit, read and history snapshots preserve file strings', async () => {
    const {request, tables, snapshots, parserOptions} = await appHarness();
    assert.ok(parserOptions.every(([, options]) => options.limit === '8mb'));
    assert.equal((await request('post', '/bot/generate_link', {key: 'file', value: text})).status, 200);
    assert.equal(tables.bot_single_value_control[0].value, text);
    assert.equal(snapshots[0][4].value, text);
    const params = {token: 'generated-token'};
    assert.equal((await request('get', '/v/:token', {}, params)).data.value, text);
    assert.equal((await request('get', '/v/:token', {}, params, {only_value: 'true'})).data, text);
    for (const route of ['/bot/set_value/:token', '/v/:token']) {
        for (const value of [text, '', ' \t\r\n\n']) {
            assert.equal((await request('post', route, {value}, params)).status, 200);
            assert.equal((await request('get', '/v/:token', {}, params)).data.value, value);
            assert.equal(snapshots.at(-1)[4].value, value);
        }
    }
});
test('one-time submission preserves text and still consumes the link exactly once', async () => {
    const {request, tables, snapshots} = await appHarness();
    tables.bot_single_value_control.push({token: 'value', value: 'old'});
    tables.bot_temporary_value_link.push({code: 'one-use', value_token: 'value', expires_at: null});
    const params = {code: 'one-use'};
    const page = await request('get', '/t/:code', {}, params);
    assert.match(page.data, /temporary-value-form/);
    assert.match(page.data, /\/js\/value_text.js/);
    assert.match(page.data, /\/js\/temporary_value.js/);
    const saved = await request('post', '/t/:code', {value: text}, params);
    assert.equal(saved.data.consumed, true);
    assert.equal(tables.bot_single_value_control[0].value, text);
    assert.equal(snapshots[0][4].value, text);
    assert.equal((await request('post', '/t/:code', {value: 'overwrite'}, params)).status, 410);
    assert.equal(tables.bot_single_value_control[0].value, text);
});
test('admin authentication and invalid token rejection remain enforced', async () => {
    const {request, tables} = await appHarness();
    tables.bot_single_value_control.push({token: 'value', value: 'old'});
    assert.equal((await request('post', '/bot/set_value/:token', {value: text}, {token: 'value'}, {}, 'wrong')).status, 401);
    assert.equal((await request('post', '/v/:token', {value: text}, {token: 'missing'})).status, 404);
    assert.equal(tables.bot_single_value_control[0].value, 'old');
});
