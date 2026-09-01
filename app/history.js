const HISTORY_TABLE = 'bot_change_history';
const DEFAULT_LIMIT = 100;

module.exports = ({app, knex, verify_request, historyLimit = DEFAULT_LIMIT}) => {
    const schemaReady = (async () => {
        if (await knex.schema.hasTable(HISTORY_TABLE)) return;
        await knex.schema.createTable(HISTORY_TABLE, table => {
            table.increments('id').primary();
            table.string('control_type', 32).notNullable().index();
            table.string('control_id', 255).notNullable().index();
            table.string('action', 32).notNullable();
            table.string('source', 64).notNullable();
            table.text('before_json').nullable();
            table.text('after_json').nullable();
            table.dateTime('created_at').notNullable().index();
        });
    })();
    schemaReady.catch(err => console.error(`Unable to initialize ${HISTORY_TABLE}:`, err.message));

    const parseJson = (value, fallback = null) => {
        if (value == null || value === '') return fallback;
        if (typeof value !== 'string') return value;
        try { return JSON.parse(value); } catch { return fallback; }
    };

    const snapshot = (type, row) => {
        if (!row) return null;
        if (type === 'toggle') return {
            botName: row.botName ?? row.bot_name,
            title: row.title ?? '',
            description: row.description ?? '',
            status: Boolean(row.status === true || row.status === 1),
            createdAt: row.createdAt ?? row.created_at ?? null,
            updatedAt: row.updatedAt ?? row.updated_at ?? null
        };
        if (type === 'value') return {
            key: row.key ?? '',
            value: row.value,
            description: row.description ?? '',
            status: Boolean(row.status === true || row.status === 1),
            token: row.token,
            botName: row.botName ?? row.bot_name ?? 'none',
            createdAt: row.createdAt ?? row.created_at ?? null,
            updatedAt: row.updatedAt ?? row.updated_at ?? null
        };
        if (type === 'mapper') return {
            key: row.key ?? '',
            title: row.title ?? '',
            description: row.description ?? '',
            token: row.token,
            example: row.example ?? parseJson(row.example_json, {}),
            rules: row.rules ?? parseJson(row.rules_json, []),
            createdAt: row.createdAt ?? row.created_at ?? null,
            updatedAt: row.updatedAt ?? row.updated_at ?? null
        };
        throw new TypeError(`Unknown control type: ${type}`);
    };

    const controlId = (type, row) => {
        const data = snapshot(type, row);
        if (!data) return null;
        return type === 'toggle' ? data.botName : data.token;
    };

    const compactValue = value => {
        if (value === undefined) return 'undefined';
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        if (text == null) return String(value);
        return text.length > 120 ? `${text.slice(0, 117)}…` : text;
    };

    const stateSummary = (type, value) => {
        if (!value) return '(deleted)';
        if (type === 'toggle') return value.status ? 'ON' : 'OFF';
        if (type === 'value') return compactValue(value.value);
        if (type === 'mapper') return `${Array.isArray(value.rules) ? value.rules.length : 0} rules`;
        return compactValue(value);
    };

    const labelFor = (type, value, id) => {
        if (!value) return id;
        if (type === 'toggle') return value.title || value.botName || id;
        if (type === 'value') return value.key || id;
        if (type === 'mapper') return value.title || value.key || id;
        return id;
    };

    async function record(type, id, action, before, after, source = 'api', db = knex) {
        await schemaReady;
        const beforeSnapshot = before == null ? null : snapshot(type, before);
        const afterSnapshot = after == null ? null : snapshot(type, after);
        const resolvedId = String(id || controlId(type, afterSnapshot || beforeSnapshot) || 'unknown');
        await db(HISTORY_TABLE).insert({
            control_type: type,
            control_id: resolvedId,
            action,
            source,
            before_json: beforeSnapshot == null ? null : JSON.stringify(beforeSnapshot),
            after_json: afterSnapshot == null ? null : JSON.stringify(afterSnapshot),
            created_at: new Date()
        });

        const oldRows = await db(HISTORY_TABLE)
            .where({control_type: type, control_id: resolvedId})
            .orderBy('id', 'desc')
            .offset(Math.max(1, Number(historyLimit) || DEFAULT_LIMIT))
            .select('id');
        if (oldRows.length) await db(HISTORY_TABLE).whereIn('id', oldRows.map(row => row.id)).del();
    }

    async function getCurrent(type, id, db = knex) {
        if (type === 'toggle') return snapshot(type, await db('bot_control').where('bot_name', id).first());
        if (type === 'value') return snapshot(type, await db('bot_single_value_control').where('token', id).first());
        if (type === 'mapper') return snapshot(type, await db('bot_condition_mapper').where('token', id).first());
        throw new TypeError(`Unknown control type: ${type}`);
    }

    async function restoreSnapshot(type, id, target, db = knex) {
        const now = new Date();
        if (type === 'toggle') {
            if (!target) return db('bot_control').where('bot_name', id).del();
            const exists = await db('bot_control').where('bot_name', id).first();
            const data = {title: target.title ?? '', description: target.description ?? '', status: target.status ? 1 : 0, updated_at: now};
            if (exists) return db('bot_control').where('bot_name', id).update(data);
            return db('bot_control').insert({bot_name: target.botName || id, ...data, created_at: target.createdAt || now});
        }
        if (type === 'value') {
            if (!target) return db('bot_single_value_control').where('token', id).del();
            const exists = await db('bot_single_value_control').where('token', id).first();
            const data = {key: target.key ?? '', value: target.value ?? '', description: target.description ?? '', status: target.status ? 1 : 0, bot_name: target.botName ?? 'none', updated_at: now};
            if (exists) return db('bot_single_value_control').where('token', id).update(data);
            return db('bot_single_value_control').insert({...data, token: target.token || id, created_at: target.createdAt || now});
        }
        if (type === 'mapper') {
            if (!target) return db('bot_condition_mapper').where('token', id).del();
            const exists = await db('bot_condition_mapper').where('token', id).first();
            const data = {key: target.key ?? '', title: target.title ?? '', description: target.description ?? '', example_json: JSON.stringify(target.example ?? {}), rules_json: JSON.stringify(target.rules ?? []), updated_at: now};
            if (exists) return db('bot_condition_mapper').where('token', id).update(data);
            return db('bot_condition_mapper').insert({...data, token: target.token || id, created_at: target.createdAt || now});
        }
        throw new TypeError(`Unknown control type: ${type}`);
    }

    const serializeHistoryRow = row => {
        const before = parseJson(row.before_json, null);
        const after = parseJson(row.after_json, null);
        const representative = after || before;
        return {
            id: row.id,
            type: row.control_type,
            controlId: row.control_id,
            label: labelFor(row.control_type, representative, row.control_id),
            action: row.action,
            source: row.source,
            before,
            after,
            from: stateSummary(row.control_type, before),
            to: stateSummary(row.control_type, after),
            createdAt: row.created_at
        };
    };

    async function list({type = null, id = null, limit = DEFAULT_LIMIT} = {}) {
        await schemaReady;
        let query = knex(HISTORY_TABLE).select('*').orderBy('id', 'desc');
        if (type) query = query.where('control_type', type);
        if (id) query = query.where('control_id', id);
        const rows = await query.limit(Math.min(500, Math.max(1, Number(limit) || DEFAULT_LIMIT)));
        return rows.map(serializeHistoryRow);
    }

    async function revert(historyId, source = 'revert') {
        await schemaReady;
        const row = await knex(HISTORY_TABLE).where('id', historyId).first();
        if (!row) return null;
        const target = parseJson(row.before_json, null);
        const type = row.control_type;
        const id = row.control_id;
        return knex.transaction(async trx => {
            const current = await getCurrent(type, id, trx);
            await restoreSnapshot(type, id, target, trx);
            const restored = await getCurrent(type, id, trx);
            await record(type, id, 'revert', current, restored, source, trx);
            return {history: serializeHistoryRow(row), restored};
        });
    }

    app.get('/bot/history', async (req, res) => {
        if (!verify_request(req, res)) return;
        try {
            res.json(await list({type: req.query.type || null, id: req.query.id || null, limit: req.query.limit || DEFAULT_LIMIT}));
        } catch (err) {
            console.error(err);
            res.status(500).json({error: 'Unable to retrieve change history.'});
        }
    });

    app.post('/bot/history/:id/revert', async (req, res) => {
        if (!verify_request(req, res)) return;
        try {
            const result = await revert(Number(req.params.id), 'web');
            if (!result) return res.status(404).json({error: 'History entry not found.'});
            res.json(result);
        } catch (err) {
            console.error(err);
            res.status(500).json({error: err.message || 'Unable to revert history entry.'});
        }
    });

    return {schemaReady, snapshot, controlId, record, list, revert, getCurrent, restoreSnapshot};
};
