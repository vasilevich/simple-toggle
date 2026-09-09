// MySQL/MariaDB TEXT is too small for files and their escaped history snapshots.
// SQLite/PostgreSQL already have unbounded TEXT. Never rewrite or shrink existing data.
module.exports = async function ensureValueTextStorage(knex, client) {
    if (!['mysql', 'mysql2', 'mariadb'].includes(client)) return;
    const columns = {
        bot_single_value_control: ['value'],
        bot_change_history: ['before_json', 'after_json']
    };
    for (const [table, names] of Object.entries(columns)) {
        for (const name of names) {
            const column = await knex('information_schema.COLUMNS')
                .select('DATA_TYPE')
                .whereRaw('TABLE_SCHEMA = DATABASE()')
                .where({TABLE_NAME: table, COLUMN_NAME: name})
                .first();
            if (!column) throw new Error(`Missing text column: ${table}.${name}`);
            if (['mediumtext', 'longtext'].includes(String(column.DATA_TYPE).toLowerCase())) continue;
            await knex.schema.alterTable(table, schema => schema.text(name, 'mediumtext').alter());
        }
    }
};
