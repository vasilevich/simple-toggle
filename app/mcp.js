const {McpServer} = require('@modelcontextprotocol/sdk/server/mcp.js');
const {StreamableHTTPServerTransport} = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const {z} = require('zod');

const MCP_GUIDE = `
# Simple Toggle MCP operating guide

You are connected to Simple Toggle, a small remote-control server. Your job is to understand the controls from their stored metadata and carry out the user's intent with as few follow-up questions as possible.

## Core behavior
- Do not guess exact control keys when the user describes a control semantically. Use search_controls first.
- Stored descriptions are the source of truth for what a control means. Titles/keys help discovery; descriptions explain intent.
- If a semantic search produces one clear match, use it. Do not ask the user to repeat the exact key.
- If several controls are genuinely plausible and changing the wrong one would matter, ask which one. Otherwise proceed with the strongest match.
- Read operations never change state. Mutating tools write to rolling history automatically.
- Prefer the specific convenience tools for common actions: flip_toggle for toggles and set_value for values.
- Use update_control when changing metadata or mapper definitions.
- Before deleting something, identify it confidently. Deletions are reversible through history, but are still destructive.
- When a user says "turn X on/off", use mode "on"/"off"; use mode "flip" only when they explicitly mean invert/toggle.
- When a user says "set X to Y", search for the value control and call set_value. set_value also marks the value control status active.
- When explaining a control, include the stored description, current state/value, and for mappers the ordered rules.

## Control types

### toggle
A boolean switch.
Identifier: the exact botName/key.
Fields: botName, title, description, status.
status=true means enabled/on; false means disabled/off.
Use flip_toggle for ordinary on/off/invert requests.

### value
A remotely editable single value.
Identifier: either its permanent token or its key. If a key is duplicated, key lookup resolves the newest matching value; use search_controls/get_control when that distinction matters.
Fields: key, value, description, status, token, botName.
The backing database stores value as text. MCP non-string values are JSON-serialized before storage; strings remain strings.
Use set_value for ordinary value changes.
botName is optional grouping metadata and defaults to "none".

### mapper
An ordered first-match condition mapper.
Identifier: either its permanent token or its key. Duplicate keys resolve newest-first.
Fields: key, title, description, token, example, rules.
Input is a JSON object. Rules are evaluated top-to-bottom. The first matching rule wins. If nothing matches, the result is {}.

Mapper rule shape:
{
  "name": "optional human name",
  "when": <condition or group>,
  "result": {"any": "JSON object"}
}

Condition shape:
{
  "type": "condition",
  "field": "destination",
  "operator": "eq",
  "value": "jpn"
}

Group shape:
{
  "type": "group",
  "op": "and",
  "children": [<condition/group>, ...]
}

Nested groups are allowed. "op" is "and" or "or".
An empty AND group matches always. An empty OR group matches never.
Field lookup supports dot paths such as "customer.type" and array indexes such as "items.0.sku".

Supported mapper operators:
- eq: equality
- neq: inequality
- gt / gte / lt / lte: numeric comparison when both sides are numeric-like, otherwise string comparison
- contains: substring for strings; membership for arrays
- starts_with / ends_with: string prefix/suffix
- in / not_in: expected value may be an array or comma-separated list
- exists: field is neither null nor undefined
- empty: null, undefined, "", [], or {} is empty
- not_empty: inverse of empty

Operators exists/empty/not_empty do not need a value.
The example object is documentation/UI assistance; it provides field names and sample values but does not limit runtime inputs.

## Mapper examples

Single condition:
{
  "name": "Japan",
  "when": {"type":"condition","field":"destination","operator":"eq","value":"jpn"},
  "result": {"coupon":"japan"}
}

Nested logic:
{
  "name": "Large Japan order",
  "when": {
    "type":"group",
    "op":"and",
    "children":[
      {"type":"condition","field":"destination","operator":"eq","value":"jpn"},
      {
        "type":"group",
        "op":"or",
        "children":[
          {"type":"condition","field":"total","operator":"gte","value":100},
          {"type":"condition","field":"customer.type","operator":"eq","value":"vip"}
        ]
      }
    ]
  },
  "result":{"coupon":"japan-priority"}
}

## History and revert
History stores before/after snapshots, timestamp, action, and source.
Typical sources include api, permanent, temporary, mcp, web, and revert.
History rolls per control according to server configuration.
revert_change restores the BEFORE snapshot of the selected history entry:
- reverting an update restores the old state/value/configuration
- reverting a delete recreates the deleted widget
- reverting a create removes the widget
The revert itself creates another history entry, so it is auditable and can itself be reasoned about later.

## Tool choice
- list_controls: inventory by optional type.
- search_controls: best first call when the user describes a control by meaning/name/value rather than exact id.
- get_control: full current object once you know type + id.
- explain_control: human-readable meaning/current state.
- create_control: create toggle/value/mapper.
- update_control: edit metadata, arbitrary value fields, or mapper example/rules.
- flip_toggle: on/off/invert boolean switches.
- set_value: change a single value.
- delete_control: delete any control.
- evaluate_mapper: test/run a mapper without editing it.
- list_history: inspect prior changes.
- revert_change: restore the before-state of a history entry.
- get_guide: return this guide verbatim when you need protocol/domain details.

## Resources
- simple-toggle://guide: this operating guide
- simple-toggle://controls: full current control inventory
- simple-toggle://history: recent history

## Authentication/security
The /mcp endpoint is intentionally unauthenticated. Do not look for or ask the user for API keys, bearer tokens, OAuth credentials, or headers for MCP. If you can reach the MCP endpoint, you may use it.
`.trim();

module.exports = ({app, knex, history, mapperApi, generateRandomToken, configuredUrl = '', temporaryLinkTable = 'bot_temporary_value_link'}) => {
    const valueForDb = value => typeof value === 'string' ? value : JSON.stringify(value);
    const result = data => ({content: [{type: 'text', text: JSON.stringify(data, null, 2)}], structuredContent: data});
    const safe = fn => async args => {
        try { return result(await fn(args || {})); }
        catch (err) { return {isError: true, content: [{type: 'text', text: err.message || String(err)}]}; }
    };

    const mapperRow = row => history.snapshot('mapper', row);
    const toggleRow = row => history.snapshot('toggle', row);
    const valueRow = row => history.snapshot('value', row);

    async function findControl(type, id) {
        const needle = String(id || '').trim();
        if (!needle) throw new Error('id is required.');
        if (type === 'toggle') {
            const row = await knex('bot_control').where('bot_name', needle).first();
            return row ? toggleRow(row) : null;
        }
        if (type === 'value') {
            let row = await knex('bot_single_value_control').where('token', needle).first();
            if (!row) row = await knex('bot_single_value_control').where('key', needle).orderBy('created_at', 'desc').first();
            return row ? valueRow(row) : null;
        }
        if (type === 'mapper') {
            await mapperApi.schemaReady;
            let row = await knex('bot_condition_mapper').where('token', needle).first();
            if (!row) row = await knex('bot_condition_mapper').where('key', needle).orderBy('created_at', 'desc').first();
            return row ? mapperRow(row) : null;
        }
        throw new Error(`Unknown control type: ${type}`);
    }

    async function listControls(type = null) {
        const output = [];
        if (!type || type === 'toggle') {
            const rows = await knex('bot_control').select('*').orderBy('bot_name');
            output.push(...rows.map(row => ({type: 'toggle', ...toggleRow(row)})));
        }
        if (!type || type === 'value') {
            const rows = await knex('bot_single_value_control').select('*').orderBy('created_at', 'desc');
            output.push(...rows.map(row => ({type: 'value', ...valueRow(row)})));
        }
        if (!type || type === 'mapper') {
            await mapperApi.schemaReady;
            const rows = await knex('bot_condition_mapper').select('*').orderBy('created_at', 'desc');
            output.push(...rows.map(row => ({type: 'mapper', ...mapperRow(row)})));
        }
        return output;
    }

    async function searchControls(query, type = null, limit = 20) {
        const needle = String(query || '').trim().toLowerCase();
        const controls = await listControls(type);
        if (!needle) return controls.slice(0, limit);
        return controls.filter(control => JSON.stringify(control).toLowerCase().includes(needle)).slice(0, limit);
    }

    const summarizeNode = node => {
        if (!node) return '(always)';
        if (node.type === 'condition') {
            const labels = {eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=', contains: 'contains', starts_with: 'starts with', ends_with: 'ends with', in: 'in', not_in: 'not in', exists: 'exists', empty: 'is empty', not_empty: 'is not empty'};
            const unary = ['exists', 'empty', 'not_empty'].includes(node.operator);
            return `${node.field} ${labels[node.operator] || node.operator}${unary ? '' : ` ${JSON.stringify(node.value)}`}`;
        }
        const children = node.children || [];
        if (!children.length) return node.op === 'or' ? '(never)' : '(always)';
        return children.map(child => child.type === 'group' ? `(${summarizeNode(child)})` : summarizeNode(child)).join(node.op === 'or' ? ' OR ' : ' AND ');
    };

    function explanation(type, control) {
        if (type === 'toggle') return `${control.title || control.botName} (${control.botName}) is currently ${control.status ? 'enabled' : 'disabled'}. ${control.description || 'No description is stored.'}`;
        if (type === 'value') return `${control.key} is currently ${JSON.stringify(control.value)}${control.botName && control.botName !== 'none' ? ` for ${control.botName}` : ''}. ${control.description || 'No description is stored.'}`;
        const rules = (control.rules || []).map((rule, index) => `${index + 1}. ${rule.name || `Rule ${index + 1}`}: ${summarizeNode(rule.when)} => ${JSON.stringify(rule.result || {})}`).join('\n');
        return `${control.title || control.key} (${control.key}) is a first-match condition mapper with ${(control.rules || []).length} rules. ${control.description || 'No description is stored.'}${rules ? `\n${rules}` : ''}`;
    }

    async function createControl(args) {
        const now = new Date();
        if (args.type === 'toggle') {
            const botName = String(args.key || '').trim();
            if (!botName) throw new Error('key is required for a toggle.');
            if (await knex('bot_control').where('bot_name', botName).first()) throw new Error(`Toggle ${botName} already exists.`);
            const row = {bot_name: botName, title: String(args.title || botName), description: String(args.description || ''), status: args.status ? 1 : 0, updated_at: now, created_at: now};
            await knex('bot_control').insert(row);
            await history.record('toggle', botName, 'create', null, row, 'mcp');
            return {type: 'toggle', ...toggleRow(row)};
        }
        if (args.type === 'value') {
            const key = String(args.key || '').trim();
            if (!key) throw new Error('key is required for a value.');
            const row = {key, value: valueForDb(args.value ?? ''), description: String(args.description || ''), status: args.status ? 1 : 0, token: await generateRandomToken(), bot_name: String(args.bot_name || 'none'), updated_at: now, created_at: now};
            await knex('bot_single_value_control').insert(row);
            await history.record('value', row.token, 'create', null, row, 'mcp');
            return {type: 'value', ...valueRow(row)};
        }
        if (args.type === 'mapper') {
            await mapperApi.schemaReady;
            const key = String(args.key || '').trim();
            if (!key) throw new Error('key is required for a mapper.');
            const row = {key, title: String(args.title || ''), description: String(args.description || ''), token: await generateRandomToken(), example_json: JSON.stringify(mapperApi.normalizeExample(args.example || {})), rules_json: JSON.stringify(mapperApi.normalizeRules(args.rules || [])), updated_at: now, created_at: now};
            await knex('bot_condition_mapper').insert(row);
            await history.record('mapper', row.token, 'create', null, row, 'mcp');
            return {type: 'mapper', ...mapperRow(row)};
        }
        throw new Error(`Unknown control type: ${args.type}`);
    }

    async function updateControl({type, id, patch}) {
        const existing = await findControl(type, id);
        if (!existing) throw new Error(`${type} control not found: ${id}`);
        const now = new Date();
        if (type === 'toggle') {
            const update = {updated_at: now};
            if (patch.title !== undefined) update.title = String(patch.title ?? '');
            if (patch.description !== undefined) update.description = String(patch.description ?? '');
            if (patch.status !== undefined || patch.enabled !== undefined) update.status = (patch.status ?? patch.enabled) ? 1 : 0;
            await knex('bot_control').where('bot_name', existing.botName).update(update);
            const after = await findControl(type, existing.botName);
            await history.record(type, existing.botName, 'update', existing, after, 'mcp');
            return {type, ...after};
        }
        if (type === 'value') {
            const update = {updated_at: now};
            if (patch.key !== undefined) update.key = String(patch.key ?? '');
            if (patch.value !== undefined) update.value = valueForDb(patch.value);
            if (patch.description !== undefined) update.description = String(patch.description ?? '');
            if (patch.status !== undefined) update.status = patch.status ? 1 : 0;
            if (patch.botName !== undefined || patch.bot_name !== undefined) update.bot_name = String(patch.botName ?? patch.bot_name ?? 'none');
            await knex('bot_single_value_control').where('token', existing.token).update(update);
            const after = await findControl(type, existing.token);
            await history.record(type, existing.token, 'update', existing, after, 'mcp');
            return {type, ...after};
        }
        await mapperApi.schemaReady;
        const update = {updated_at: now};
        if (patch.key !== undefined) { const key = String(patch.key || '').trim(); if (!key) throw new Error('Mapper key cannot be empty.'); update.key = key; }
        if (patch.title !== undefined) update.title = String(patch.title ?? '');
        if (patch.description !== undefined) update.description = String(patch.description ?? '');
        if (patch.example !== undefined) update.example_json = JSON.stringify(mapperApi.normalizeExample(patch.example));
        if (patch.rules !== undefined) update.rules_json = JSON.stringify(mapperApi.normalizeRules(patch.rules));
        await knex('bot_condition_mapper').where('token', existing.token).update(update);
        const after = await findControl(type, existing.token);
        await history.record(type, existing.token, 'update', existing, after, 'mcp');
        return {type, ...after};
    }

    async function deleteControl({type, id}) {
        const existing = await findControl(type, id);
        if (!existing) throw new Error(`${type} control not found: ${id}`);
        const stableId = type === 'toggle' ? existing.botName : existing.token;
        await knex.transaction(async trx => {
            if (type === 'toggle') await trx('bot_control').where('bot_name', stableId).del();
            else if (type === 'value') {
                await trx(temporaryLinkTable).where('value_token', stableId).del();
                await trx('bot_single_value_control').where('token', stableId).del();
            } else await trx('bot_condition_mapper').where('token', stableId).del();
            await history.record(type, stableId, 'delete', existing, null, 'mcp', trx);
        });
        return {deleted: true, type, id: stableId, previous: existing};
    }

    function buildServer() {
        const server = new McpServer(
            {name: 'simple-toggle', version: '1.1.0'},
            {instructions: MCP_GUIDE}
        );

        const controlType = z.enum(['toggle', 'value', 'mapper']).describe('Control category: toggle=boolean switch, value=single editable value, mapper=ordered condition mapper.');
        const id = z.string().min(1).describe('Control identifier. Toggle: exact key/botName. Value or mapper: permanent token OR key; duplicate keys resolve newest-first.');
        const readOnly = {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false};
        const mutate = {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false};

        server.registerTool('get_guide', {
            title: 'Read the Simple Toggle operating guide',
            description: 'Returns the complete domain guide for this MCP server: control semantics, identifier rules, mapper JSON grammar/operators, history/revert behavior, tool choice, and authentication behavior. Use this instead of asking the user protocol questions.',
            inputSchema: z.object({}),
            annotations: readOnly
        }, safe(async () => ({guide: MCP_GUIDE})));

        server.registerTool('list_controls', {
            title: 'List Simple Toggle controls',
            description: 'Return the current inventory. Each result includes its type plus current state/value/configuration and stored description. Omit type to return toggles, values, and mappers together.',
            inputSchema: z.object({
                type: controlType.optional().describe('Optional filter. Omit to list all control types.')
            }),
            annotations: readOnly
        }, safe(async ({type}) => ({controls: await listControls(type || null)})));

        server.registerTool('search_controls', {
            title: 'Search controls by meaning, name, value, or definition',
            description: 'Best discovery tool when the user does not provide an exact key. Searches serialized keys, titles, descriptions, current values, bot grouping, mapper examples, and mapper rules. If one result clearly matches the user intent, use it without asking for the exact key.',
            inputSchema: z.object({
                query: z.string().describe('Free-text search terms from the user intent, e.g. "coupon", "Japan order", "maintenance", or a known current value.'),
                type: controlType.optional().describe('Optional type filter when the intended kind is known.'),
                limit: z.number().int().min(1).max(100).optional().describe('Maximum results. Defaults to 20.')
            }),
            annotations: readOnly
        }, safe(async ({query, type, limit}) => ({controls: await searchControls(query, type || null, limit || 20)})));

        server.registerTool('get_control', {
            title: 'Get one control in full',
            description: 'Read the complete current snapshot of a known control. For toggles id is the exact key/botName. For values and mappers id can be token or key; key lookup resolves the newest matching control.',
            inputSchema: z.object({type: controlType, id}),
            annotations: readOnly
        }, safe(async ({type, id}) => {
            const control = await findControl(type, id);
            if (!control) throw new Error(`${type} control not found: ${id}`);
            return {type, control};
        }));

        server.registerTool('explain_control', {
            title: 'Explain what a control means and its current state',
            description: 'Human-readable explanation grounded in stored metadata. Toggle explanation includes on/off state; value includes current value/group; mapper includes first-match behavior and every ordered rule. Descriptions are treated as authoritative when present.',
            inputSchema: z.object({type: controlType, id}),
            annotations: readOnly
        }, safe(async ({type, id}) => {
            const control = await findControl(type, id);
            if (!control) throw new Error(`${type} control not found: ${id}`);
            return {type, control, explanation: explanation(type, control)};
        }));

        server.registerTool('create_control', {
            title: 'Create a toggle, value, or mapper',
            description: 'Create a new control and record creation in history. Always provide a useful description when the user has supplied enough context; future AIs use descriptions to understand purpose. Toggle uses key/title/description/status. Value uses key/value/description/status/bot_name. Mapper uses key/title/description/example/rules.',
            inputSchema: z.object({
                type: controlType,
                key: z.string().min(1).describe('Human/machine key. For toggle this becomes botName. For value/mapper this is the searchable key; a separate permanent token is generated automatically.'),
                title: z.string().optional().describe('Display title. Most useful for toggles and mappers. Toggle defaults title to key.'),
                description: z.string().optional().describe('Plain-language purpose/meaning. Make it specific enough that another AI can decide when and how to change the control without asking the user.'),
                status: z.boolean().optional().describe('Initial active state. Toggle: on/off. Value: control status metadata. Defaults false.'),
                value: z.any().optional().describe('Initial value for type=value. Strings stay strings; non-strings are JSON-serialized into text storage.'),
                bot_name: z.string().optional().describe('Optional grouping label for type=value. Defaults to "none".'),
                example: z.record(z.string(), z.any()).optional().describe('For type=mapper: representative input object used by the web UI to discover field names/example values. It does not restrict runtime inputs.'),
                rules: z.array(z.any()).optional().describe('For type=mapper: ordered first-match rules. Each rule: {name?, when:<condition/group>, result:<object>}. See get_guide for exact grammar/operators.')
            }),
            annotations: mutate
        }, safe(createControl));

        server.registerTool('update_control', {
            title: 'Update any editable control field',
            description: 'Generic patch operation. Use for metadata edits and mapper definitions. Toggle patch: status or enabled, title, description. Value patch: key, value, description, status, bot_name/botName. Mapper patch: key, title, description, example, rules. Only supplied fields change; omitted fields remain untouched. The before/after state is recorded in history.',
            inputSchema: z.object({
                type: controlType,
                id,
                patch: z.record(z.string(), z.any()).describe('Partial update object. Use canonical fields described in this tool. Mapper rules replace the full ordered rule list when supplied.')
            }),
            annotations: mutate
        }, safe(updateControl));

        server.registerTool('flip_toggle', {
            title: 'Turn a toggle on, off, or invert it',
            description: 'Convenience tool for boolean controls. Use mode=on for "enable/turn on", mode=off for "disable/turn off", and mode=flip only for "toggle/invert/change to opposite". The change is recorded in history.',
            inputSchema: z.object({
                id: z.string().min(1).describe('Exact toggle key/botName. If the user gave only a semantic name, resolve it first with search_controls.'),
                mode: z.enum(['on', 'off', 'flip']).default('flip').describe('Desired operation: on, off, or invert current state.')
            }),
            annotations: mutate
        }, safe(async ({id, mode}) => {
            const current = await findControl('toggle', id);
            if (!current) throw new Error(`Toggle not found: ${id}`);
            return updateControl({type: 'toggle', id: current.botName, patch: {status: mode === 'flip' ? !current.status : mode === 'on'}});
        }));

        server.registerTool('set_value', {
            title: 'Set a value control',
            description: 'Convenience tool for ordinary value changes. id accepts permanent token or key; duplicate key lookup chooses newest. The supplied value is stored (non-strings JSON-serialized) and status becomes active/true. The change is recorded in history.',
            inputSchema: z.object({
                id: z.string().min(1).describe('Value permanent token or key. If user named it semantically, resolve with search_controls first.'),
                value: z.any().describe('New value. Strings remain strings; non-strings are JSON-serialized into the existing text-backed value storage.')
            }),
            annotations: mutate
        }, safe(async ({id, value}) => updateControl({type: 'value', id, patch: {value, status: true}})));

        server.registerTool('delete_control', {
            title: 'Delete a control',
            description: 'Delete a toggle, value, or mapper after identifying it confidently. Values also lose outstanding one-time setter links. The full pre-delete snapshot is retained in rolling history and can later be restored with revert_change.',
            inputSchema: z.object({type: controlType, id}),
            annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false}
        }, safe(deleteControl));

        server.registerTool('evaluate_mapper', {
            title: 'Evaluate a condition mapper without modifying it',
            description: 'Run an input JSON object through an existing mapper. Rules are evaluated in stored order and the first match wins; no match returns {}. merge=false returns only the mapper result. merge=true returns input overlaid with the mapper result. This tool is read-only.',
            inputSchema: z.object({
                id: z.string().min(1).describe('Mapper permanent token or key. Duplicate key lookup chooses newest.'),
                input: z.record(z.string(), z.any()).describe('Runtime JSON object to test against mapper conditions. Dot-path fields are resolved inside this object.'),
                merge: z.boolean().optional().describe('If true, return {...input, ...matchedResult}; otherwise return only matchedResult. Defaults false.')
            }),
            annotations: readOnly
        }, safe(async ({id, input, merge}) => {
            const mapper = await findControl('mapper', id);
            if (!mapper) throw new Error(`Mapper not found: ${id}`);
            const match = mapperApi.evaluateRules(mapperApi.normalizeRules(mapper.rules || []), input);
            return {matched: match.matched, ruleIndex: match.ruleIndex, ruleName: match.rule?.name || '', result: merge ? {...input, ...match.result} : match.result};
        }));

        server.registerTool('list_history', {
            title: 'List recent control changes',
            description: 'Return rolling audit history with history id, type, stable control id, label, action, source, before snapshot, after snapshot, compact from/to summaries, and timestamp. Filter by type and/or stable id when needed.',
            inputSchema: z.object({
                type: controlType.optional().describe('Optional control-type filter.'),
                id: z.string().optional().describe('Optional stable control id: toggle key/botName, value token, or mapper token.'),
                limit: z.number().int().min(1).max(500).optional().describe('Maximum rows, newest first. Defaults to the history module default.')
            }),
            annotations: readOnly
        }, safe(async args => ({history: await history.list(args)})));

        server.registerTool('revert_change', {
            title: 'Revert one history entry',
            description: 'Restore the BEFORE snapshot of the selected history entry. Update -> restores old state; delete -> recreates deleted widget; create -> removes created widget. The revert itself is recorded as a new history entry.',
            inputSchema: z.object({
                history_id: z.number().int().positive().describe('Numeric id returned by list_history. This targets the exact historical event, not merely a control.')
            }),
            annotations: mutate
        }, safe(async ({history_id}) => {
            const reverted = await history.revert(history_id, 'mcp');
            if (!reverted) throw new Error(`History entry not found: ${history_id}`);
            return reverted;
        }));

        server.registerResource('guide', 'simple-toggle://guide', {
            title: 'Simple Toggle MCP operating guide',
            description: 'Complete instructions for control types, discovery, ids, mapper grammar/operators, history/revert, tool choice, and authentication.',
            mimeType: 'text/markdown'
        }, async uri => ({contents: [{uri: uri.href, mimeType: 'text/markdown', text: MCP_GUIDE}]}));

        server.registerResource('controls', 'simple-toggle://controls', {
            title: 'Simple Toggle controls',
            description: 'Full current inventory of toggles, values, and mappers including descriptions and current configuration.',
            mimeType: 'application/json'
        }, async uri => ({contents: [{uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await listControls(), null, 2)}]}));

        server.registerResource('history', 'simple-toggle://history', {
            title: 'Simple Toggle recent history',
            description: 'Recent control changes with before/after snapshots, source, and timestamps.',
            mimeType: 'application/json'
        }, async uri => ({contents: [{uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await history.list({limit: 100}), null, 2)}]}));

        return server;
    }

    const originAllowed = req => {
        const origin = req.get('origin');
        if (!origin) return true;
        try {
            const originUrl = new URL(origin);
            if (originUrl.host === req.get('host')) return true;
            if (configuredUrl && originUrl.origin === new URL(configuredUrl).origin) return true;
            return false;
        } catch { return false; }
    };

    app.post('/mcp', async (req, res) => {
        if (!originAllowed(req)) return res.status(403).json({error: 'Origin not allowed.'});
        const server = buildServer();
        try {
            const transport = new StreamableHTTPServerTransport({sessionIdGenerator: undefined});
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
            res.on('close', () => { Promise.resolve(transport.close()).catch(() => {}); Promise.resolve(server.close()).catch(() => {}); });
        } catch (err) {
            console.error('MCP request failed:', err);
            if (!res.headersSent) res.status(500).json({jsonrpc: '2.0', error: {code: -32603, message: 'Internal MCP server error'}, id: null});
        }
    });

    const methodNotAllowed = (req, res) => res.status(405).json({jsonrpc: '2.0', error: {code: -32000, message: 'Method not allowed.'}, id: null});
    app.get('/mcp', methodNotAllowed);
    app.delete('/mcp', methodNotAllowed);

    return {buildServer, listControls, searchControls, findControl, guide: MCP_GUIDE};
};
