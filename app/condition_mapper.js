const TABLE = 'bot_condition_mapper';

module.exports = ({app, knex, verify_request, generateRandomToken, getBaseUrl}) => {
    const schemaReady = (async () => {
        if (await knex.schema.hasTable(TABLE)) return;
        await knex.schema.createTable(TABLE, table => {
            table.increments('id').primary();
            table.string('key', 255).notNullable().index();
            table.text('title');
            table.text('description');
            table.text('token').notNullable().unique();
            table.text('example_json').notNullable();
            table.text('rules_json').notNullable();
            table.dateTime('updated_at').notNullable();
            table.dateTime('created_at').notNullable();
        });
    })();
    schemaReady.catch(err => console.error(`Unable to initialize ${TABLE}:`, err.message));

    const parseJson = (value, fallback) => {
        if (value == null || value === '') return fallback;
        if (typeof value !== 'string') return value;
        try { return JSON.parse(value); } catch { return fallback; }
    };

    const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const allowedOperators = new Set([
        'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'starts_with', 'ends_with',
        'in', 'not_in', 'exists', 'empty', 'not_empty'
    ]);

    const normalizeNode = node => {
        if (node && Array.isArray(node.and)) return {type: 'group', op: 'and', children: node.and.map(normalizeNode)};
        if (node && Array.isArray(node.or)) return {type: 'group', op: 'or', children: node.or.map(normalizeNode)};
        if (!node || typeof node !== 'object') throw new TypeError('Condition nodes must be objects.');
        if (node.type === 'group' || Array.isArray(node.children)) {
            const op = String(node.op || 'and').toLowerCase();
            if (!['and', 'or'].includes(op)) throw new TypeError('Condition group op must be "and" or "or".');
            return {type: 'group', op, children: (node.children || []).map(normalizeNode)};
        }
        const field = String(node.field ?? '').trim();
        const operatorAliases = {'=': 'eq', '==': 'eq', '!=': 'neq', '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte', startsWith: 'starts_with', endsWith: 'ends_with'};
        const operator = operatorAliases[node.operator] || String(node.operator || 'eq');
        if (!field) throw new TypeError('Every condition requires a field.');
        if (!allowedOperators.has(operator)) throw new TypeError(`Unsupported operator: ${operator}`);
        return {type: 'condition', field, operator, ...(operator === 'exists' || operator === 'empty' || operator === 'not_empty' ? {} : {value: node.value})};
    };

    const normalizeRules = rules => {
        if (!Array.isArray(rules)) throw new TypeError('rules must be an array.');
        return rules.map((rule, index) => {
            if (!rule || typeof rule !== 'object') throw new TypeError(`Rule ${index + 1} must be an object.`);
            const result = rule.result ?? rule.output ?? {};
            if (!isPlainObject(result)) throw new TypeError(`Rule ${index + 1} result must be a JSON object.`);
            return {
                name: String(rule.name ?? ''),
                when: normalizeNode(rule.when ?? rule.conditions ?? {type: 'group', op: 'and', children: []}),
                result
            };
        });
    };

    const normalizeExample = example => {
        const value = parseJson(example, {});
        if (!isPlainObject(value)) throw new TypeError('example must be a JSON object.');
        return value;
    };

    const getPath = (obj, path) => {
        if (obj != null && Object.prototype.hasOwnProperty.call(obj, path)) return obj[path];
        return String(path).split('.').reduce((value, key) => value == null ? undefined : value[key], obj);
    };

    const asBoolean = value => {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'number') return value !== 0;
        if (typeof value === 'string') {
            const lowered = value.trim().toLowerCase();
            if (['true', '1', 'yes', 'y'].includes(lowered)) return true;
            if (['false', '0', 'no', 'n', ''].includes(lowered)) return false;
        }
        return Boolean(value);
    };

    const equalValue = (actual, expected) => {
        if (expected === null) return actual == null;
        if (typeof expected === 'number') {
            if (actual === '' || actual == null) return false;
            const numeric = Number(actual);
            return Number.isFinite(numeric) && numeric === expected;
        }
        if (typeof expected === 'boolean') return asBoolean(actual) === expected;
        if (typeof expected === 'object') {
            try { return JSON.stringify(actual) === JSON.stringify(expected); } catch { return false; }
        }
        return String(actual ?? '') === String(expected ?? '');
    };

    const compareValue = (actual, expected) => {
        const a = Number(actual);
        const b = Number(expected);
        if (actual !== '' && expected !== '' && Number.isFinite(a) && Number.isFinite(b)) return a === b ? 0 : (a > b ? 1 : -1);
        return String(actual ?? '').localeCompare(String(expected ?? ''));
    };

    const isEmpty = value => value == null || value === '' || (Array.isArray(value) && value.length === 0) || (isPlainObject(value) && Object.keys(value).length === 0);

    const evaluateCondition = (condition, input) => {
        const actual = getPath(input, condition.field);
        const expected = condition.value;
        switch (condition.operator) {
            case 'eq': return equalValue(actual, expected);
            case 'neq': return !equalValue(actual, expected);
            case 'gt': return compareValue(actual, expected) > 0;
            case 'gte': return compareValue(actual, expected) >= 0;
            case 'lt': return compareValue(actual, expected) < 0;
            case 'lte': return compareValue(actual, expected) <= 0;
            case 'contains': return Array.isArray(actual) ? actual.some(value => equalValue(value, expected)) : String(actual ?? '').includes(String(expected ?? ''));
            case 'starts_with': return String(actual ?? '').startsWith(String(expected ?? ''));
            case 'ends_with': return String(actual ?? '').endsWith(String(expected ?? ''));
            case 'in': {
                const list = Array.isArray(expected) ? expected : String(expected ?? '').split(',').map(value => value.trim());
                return list.some(value => equalValue(actual, value));
            }
            case 'not_in': {
                const list = Array.isArray(expected) ? expected : String(expected ?? '').split(',').map(value => value.trim());
                return !list.some(value => equalValue(actual, value));
            }
            case 'exists': return actual !== undefined && actual !== null;
            case 'empty': return isEmpty(actual);
            case 'not_empty': return !isEmpty(actual);
            default: return false;
        }
    };

    const evaluateNode = (node, input) => {
        if (node.type === 'condition') return evaluateCondition(node, input);
        const children = node.children || [];
        if (node.op === 'or') return children.some(child => evaluateNode(child, input));
        return children.every(child => evaluateNode(child, input));
    };

    const evaluateRules = (rules, input) => {
        for (let index = 0; index < rules.length; index++) {
            if (evaluateNode(rules[index].when, input)) return {matched: true, ruleIndex: index, rule: rules[index], result: rules[index].result};
        }
        return {matched: false, ruleIndex: -1, rule: null, result: {}};
    };

    const serializeRow = (req, row) => ({
        key: row.key,
        title: row.title || '',
        description: row.description || '',
        token: row.token,
        accessToken: row.token,
        runtimeUrl: `${getBaseUrl(req)}/m/${encodeURIComponent(row.token)}`,
        example: parseJson(row.example_json, {}),
        rules: parseJson(row.rules_json, []),
        updatedAt: row.updated_at,
        createdAt: row.created_at
    });

    const mapperUpdate = body => {
        const update = {updated_at: new Date()};
        if (body.key !== undefined) {
            const key = String(body.key).trim();
            if (!key) throw new TypeError('key is required.');
            update.key = key;
        }
        if (body.title !== undefined) update.title = String(body.title ?? '');
        if (body.description !== undefined) update.description = String(body.description ?? '');
        if (body.example !== undefined || body.example_json !== undefined) update.example_json = JSON.stringify(normalizeExample(body.example ?? body.example_json));
        if (body.rules !== undefined || body.rules_json !== undefined) update.rules_json = JSON.stringify(normalizeRules(parseJson(body.rules ?? body.rules_json, [])));
        return update;
    };

    app.get('/bot/mappers', async (req, res) => {
        if (!verify_request(req, res)) return;
        try {
            await schemaReady;
            const rows = await knex(TABLE).select('*').orderBy('created_at', 'desc');
            res.json(rows.map(row => serializeRow(req, row)));
        } catch (err) {
            console.error(err);
            res.status(500).json({error: 'Unable to retrieve condition mappers.'});
        }
    });

    app.post('/bot/mappers', async (req, res) => {
        if (!verify_request(req, res)) return;
        try {
            await schemaReady;
            const key = String(req.body?.key ?? '').trim();
            if (!key) return res.status(400).json({error: 'key is required.'});
            const now = new Date();
            const row = {
                key,
                title: String(req.body?.title ?? ''),
                description: String(req.body?.description ?? ''),
                token: await generateRandomToken(),
                example_json: JSON.stringify(normalizeExample(req.body?.example ?? {})),
                rules_json: JSON.stringify(normalizeRules(req.body?.rules ?? [])),
                updated_at: now,
                created_at: now
            };
            await knex(TABLE).insert(row);
            res.status(201).json(serializeRow(req, row));
        } catch (err) {
            console.error(err);
            res.status(err instanceof TypeError ? 400 : 500).json({error: err.message || 'Unable to create condition mapper.'});
        }
    });

    app.get('/bot/mappers/:token', async (req, res) => {
        if (!verify_request(req, res)) return;
        try {
            await schemaReady;
            const row = await knex(TABLE).where('token', req.params.token).first();
            if (!row) return res.status(404).json({error: 'Condition mapper not found.'});
            res.json(serializeRow(req, row));
        } catch (err) {
            console.error(err);
            res.status(500).json({error: 'Unable to retrieve condition mapper.'});
        }
    });

    const updateHandler = async (req, res) => {
        if (!verify_request(req, res)) return;
        try {
            await schemaReady;
            const existing = await knex(TABLE).where('token', req.params.token).first();
            if (!existing) return res.status(404).json({error: 'Condition mapper not found.'});
            const update = mapperUpdate(req.body || {});
            await knex(TABLE).where('token', req.params.token).update(update);
            const row = {...existing, ...update};
            res.json(serializeRow(req, row));
        } catch (err) {
            console.error(err);
            res.status(err instanceof TypeError ? 400 : 500).json({error: err.message || 'Unable to update condition mapper.'});
        }
    };
    app.post('/bot/mappers/:token', updateHandler);
    app.put('/bot/mappers/:token', updateHandler);

    app.delete('/bot/mappers/:token', async (req, res) => {
        if (!verify_request(req, res)) return;
        try {
            await schemaReady;
            const deleted = await knex(TABLE).where('token', req.params.token).del();
            if (!deleted) return res.status(404).json({error: 'Condition mapper not found.'});
            res.json({status: 'success'});
        } catch (err) {
            console.error(err);
            res.status(500).json({error: 'Unable to delete condition mapper.'});
        }
    });

    app.post('/bot/mappers/:token/test', async (req, res) => {
        if (!verify_request(req, res)) return;
        try {
            await schemaReady;
            const row = await knex(TABLE).where('token', req.params.token).first();
            if (!row) return res.status(404).json({error: 'Condition mapper not found.'});
            const input = req.body ?? {};
            if (!isPlainObject(input)) return res.status(400).json({error: 'Input must be a JSON object.'});
            const match = evaluateRules(normalizeRules(parseJson(row.rules_json, [])), input);
            res.json({matched: match.matched, ruleIndex: match.ruleIndex, ruleName: match.rule?.name || '', result: match.result});
        } catch (err) {
            console.error(err);
            res.status(500).json({error: 'Unable to test condition mapper.'});
        }
    });

    app.post('/m/:token', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            await schemaReady;
            const row = await knex(TABLE).where('token', req.params.token).first();
            if (!row) return res.status(404).json({error: 'Invalid mapper access token.'});
            const input = req.body ?? {};
            if (!isPlainObject(input)) return res.status(400).json({error: 'Input must be a JSON object.'});
            const match = evaluateRules(normalizeRules(parseJson(row.rules_json, [])), input);
            const result = req.query.merge === 'true' ? {...input, ...match.result} : match.result;
            if (req.query.meta === 'true') {
                return res.json({matched: match.matched, ruleIndex: match.ruleIndex, ruleName: match.rule?.name || '', result});
            }
            res.json(result);
        } catch (err) {
            console.error(err);
            res.status(500).json({error: 'Unable to evaluate condition mapper.'});
        }
    });

    return {schemaReady, evaluateRules, normalizeRules};
};
