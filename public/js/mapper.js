(() => {
    const params = new URLSearchParams(location.search);
    const token = params.get('token');
    const mapperPanel = document.getElementById('mapper-control-panel');
    if (!token || !mapperPanel) return;

    const isAdmin = params.get('admin_mode') !== 'false';
    const globalError = document.getElementById('global-error');
    const createModal = document.getElementById('create-mapper-modal');
    const editorModal = document.getElementById('mapper-editor-modal');
    const ruleModal = document.getElementById('mapper-rule-modal');
    const fieldList = document.getElementById('mapper-field-options');
    const operatorLabels = {eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=', contains: 'contains', starts_with: 'starts with', ends_with: 'ends with', in: 'in', not_in: 'not in', exists: 'exists', empty: 'is empty', not_empty: 'is not empty'};
    const unaryOperators = new Set(['exists', 'empty', 'not_empty']);
    const expressionTypes = {
        const: 'Constant', field: 'Field', add: 'Add (+)', subtract: 'Subtract (-)', multiply: 'Multiply (×)', divide: 'Divide (÷)',
        concat: 'Concat text', coalesce: 'Coalesce/default', conditional: 'Conditional (if/then/else)'
    };
    if (!isAdmin) document.getElementById('open-create-mapper').hidden = true;

    let mappers = [];
    let currentMapper = null;
    let currentRuleIndex = -1;
    let workingWhen = null;
    let workingActions = [];

    const clone = value => JSON.parse(JSON.stringify(value));
    const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const newCondition = () => ({type: 'condition', field: '', operator: 'eq', value: ''});
    const newGroup = () => ({type: 'group', op: 'and', children: [newCondition()]});
    const newExpression = type => {
        if (type === 'field') return {type: 'field', path: ''};
        if (type === 'conditional') return {type: 'conditional', when: newGroup(), then: {type: 'const', value: ''}, else: {type: 'const', value: ''}};
        if (['add', 'subtract', 'multiply', 'divide', 'concat', 'coalesce'].includes(type)) return {type: 'op', op: type, args: [{type: 'const', value: ''}, {type: 'const', value: ''}]};
        return {type: 'const', value: ''};
    };
    const newAction = type => type === 'unset' ? {type: 'unset', field: ''} : {type: 'set', field: '', value: newExpression('const')};

    function showError(message) { globalError.textContent = message; globalError.hidden = false; }
    function clearError() { globalError.textContent = ''; globalError.hidden = true; }

    async function api(path, options = {}) {
        const headers = new Headers(options.headers || {});
        headers.set('Authorization', `Bearer ${token}`);
        if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
        const response = await fetch(path, {...options, headers});
        const text = await response.text();
        let data = null;
        if (text) { try { data = JSON.parse(text); } catch { data = text; } }
        if (!response.ok) throw new Error(data?.error || data || `Request failed (${response.status})`);
        return data;
    }

    function parseObject(text, label) {
        let value;
        try { value = JSON.parse(text || '{}'); } catch (err) { throw new Error(`${label} is not valid JSON: ${err.message}`); }
        if (!isPlainObject(value)) throw new Error(`${label} must be a JSON object.`);
        return value;
    }

    function parseLooseValue(value) {
        if (typeof value !== 'string') return value;
        const trimmed = value.trim();
        if (trimmed === '') return '';
        if (trimmed === 'null') return null;
        if (trimmed === 'true') return true;
        if (trimmed === 'false') return false;
        if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed)) return Number(trimmed);
        if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"')) {
            try { return JSON.parse(trimmed); } catch {}
        }
        return value;
    }

    function getPath(obj, path) {
        if (obj != null && Object.prototype.hasOwnProperty.call(obj, path)) return obj[path];
        return String(path || '').split('.').reduce((value, key) => value == null ? undefined : value[key], obj);
    }

    function flattenExample(value, prefix = '', out = []) {
        if (Array.isArray(value)) {
            if (prefix) out.push({path: prefix, value});
            if (value.length) flattenExample(value[0], prefix ? `${prefix}.0` : '0', out);
            return out;
        }
        if (isPlainObject(value)) {
            const keys = Object.keys(value);
            if (!keys.length && prefix) out.push({path: prefix, value});
            keys.forEach(key => flattenExample(value[key], prefix ? `${prefix}.${key}` : key, out));
            return out;
        }
        if (prefix) out.push({path: prefix, value});
        return out;
    }

    function compactExample(value) {
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        return text.length > 70 ? `${text.slice(0, 67)}…` : text;
    }

    function getEditorExample() {
        try { return parseObject(document.getElementById('mapper-example-input').value, 'Example object'); }
        catch { return currentMapper?.example || {}; }
    }

    function refreshFieldList(example = getEditorExample()) {
        fieldList.replaceChildren(...flattenExample(example).map(item => {
            const option = document.createElement('option');
            option.value = item.path;
            option.label = compactExample(item.value);
            return option;
        }));
    }

    function formatValue(value) {
        if (typeof value === 'string') return value;
        if (value === undefined) return '';
        try { return JSON.stringify(value); } catch { return String(value); }
    }

    function coerceScalar(text, sample) {
        if (typeof text !== 'string') return text;
        const trimmed = text.trim();
        if (typeof sample === 'number' && trimmed !== '' && Number.isFinite(Number(trimmed))) return Number(trimmed);
        if (typeof sample === 'boolean') {
            if (['true', '1', 'yes', 'y'].includes(trimmed.toLowerCase())) return true;
            if (['false', '0', 'no', 'n'].includes(trimmed.toLowerCase())) return false;
        }
        if (sample === null && trimmed === 'null') return null;
        if (Array.isArray(sample) || isPlainObject(sample)) { try { return JSON.parse(trimmed); } catch { return text; } }
        return parseLooseValue(text);
    }

    function coerceNode(node, example) {
        if (node.type === 'group') return {type: 'group', op: node.op, children: node.children.map(child => coerceNode(child, example))};
        const result = {type: 'condition', field: String(node.field || '').trim(), operator: node.operator};
        if (!result.field) throw new Error('Every condition needs a field.');
        if (!unaryOperators.has(result.operator)) {
            const sample = getPath(example, result.field);
            if (['in', 'not_in'].includes(result.operator)) {
                const raw = formatValue(node.value).trim();
                if (raw.startsWith('[')) { try { result.value = JSON.parse(raw); } catch { throw new Error(`"${result.field}" list must be valid JSON or comma separated.`); } }
                else result.value = raw.split(',').map(value => coerceScalar(value.trim(), sample));
            } else result.value = coerceScalar(formatValue(node.value), sample);
        }
        return result;
    }

    function coerceExpression(expr, example) {
        if (!expr || typeof expr !== 'object') return {type: 'const', value: parseLooseValue(expr)};
        if (expr.type === 'const') return {type: 'const', value: parseLooseValue(expr.value)};
        if (expr.type === 'field') {
            const path = String(expr.path || '').trim();
            if (!path) throw new Error('Field expressions need a field.');
            return {type: 'field', path};
        }
        if (expr.type === 'conditional') return {type: 'conditional', when: coerceNode(expr.when || newGroup(), example), then: coerceExpression(expr.then, example), else: coerceExpression(expr.else, example)};
        if (expr.type === 'op') return {type: 'op', op: expr.op, args: (expr.args || []).map(arg => coerceExpression(arg, example))};
        throw new Error(`Unsupported expression type ${expr.type}`);
    }

    function resultToActions(result) {
        return Object.entries(result || {}).map(([field, value]) => ({type: 'set', field, value: {type: 'const', value}}));
    }

    function summarizeNode(node) {
        if (!node) return '(always)';
        if (node.type === 'condition') return `${node.field || '?'} ${operatorLabels[node.operator] || node.operator} ${unaryOperators.has(node.operator) ? '' : formatValue(node.value)}`.trim();
        if (!node.children?.length) return node.op === 'or' ? '(never)' : '(always)';
        const glue = node.op === 'or' ? ' OR ' : ' AND ';
        return node.children.map(child => child.type === 'group' ? `(${summarizeNode(child)})` : summarizeNode(child)).join(glue);
    }

    function summarizeExpression(expr) {
        if (!expr) return 'null';
        if (expr.type === 'const') return formatValue(expr.value);
        if (expr.type === 'field') return `[${expr.path || '?'}]`;
        if (expr.type === 'conditional') return `IF ${summarizeNode(expr.when)} THEN ${summarizeExpression(expr.then)} ELSE ${summarizeExpression(expr.else)}`;
        const symbols = {add: ' + ', subtract: ' - ', multiply: ' × ', divide: ' ÷ ', concat: ' concat ', coalesce: ' ?? '};
        return `(${(expr.args || []).map(summarizeExpression).join(symbols[expr.op] || ` ${expr.op} `)})`;
    }

    function summarizeActions(rule) {
        const actions = rule.actions || resultToActions(rule.result);
        if (!actions.length) return '(no actions)';
        return actions.map(action => action.type === 'unset' ? `unset ${action.field}` : `${action.field} = ${summarizeExpression(action.value)}`).join('; ');
    }

    async function copyText(text, button = null) {
        try { await navigator.clipboard.writeText(text); } catch { prompt('Copy this URL:', text); }
        if (button) { const original = button.textContent; button.textContent = 'Copied'; setTimeout(() => button.textContent = original, 900); }
    }

    function mapperCard(mapper) {
        const card = document.createElement('article');
        card.className = 'control-card';
        card.dataset.search = `${mapper.key || ''} ${mapper.title || ''} ${mapper.description || ''}`.toLowerCase();
        card.innerHTML = `<div class="control-card-header"><div><h3></h3><div class="meta"><span class="badge mapper-key"></span><span class="badge mapper-rules"></span></div></div><span class="badge">mapper</span></div><p class="description"></p><div class="card-actions"><button class="button button-primary button-small edit-mapper" type="button">Edit rules</button><button class="button button-secondary button-small copy-mapper" type="button">Copy definition URL</button><button class="button button-danger button-small delete-mapper" type="button">Delete</button></div>`;
        card.querySelector('h3').textContent = mapper.title || mapper.key;
        card.querySelector('.mapper-key').textContent = mapper.key;
        card.querySelector('.mapper-rules').textContent = `${mapper.rules?.length || 0} rules`;
        card.querySelector('.description').textContent = mapper.description || 'No description';
        const editMapper = card.querySelector('.edit-mapper');
        if (!isAdmin) editMapper.hidden = true;
        editMapper.addEventListener('click', () => openMapperEditor(mapper));
        card.querySelector('.copy-mapper').addEventListener('click', event => copyText(mapper.definitionKeyUrl || mapper.definitionUrl || mapper.runtimeUrl, event.currentTarget));
        const remove = card.querySelector('.delete-mapper');
        if (!isAdmin) remove.hidden = true;
        remove.addEventListener('click', async () => {
            if (!confirm(`Delete mapper ${mapper.key}?`)) return;
            try { await api(`/bot/mappers/${encodeURIComponent(mapper.token)}`, {method: 'DELETE'}); await loadMappers(); }
            catch (err) { showError(err.message); }
        });
        return card;
    }

    async function loadMappers() {
        const loading = document.getElementById('mappers-loading');
        const empty = document.getElementById('mappers-empty');
        try {
            mappers = await api('/bot/mappers');
            mapperPanel.replaceChildren(...mappers.map(mapperCard));
            document.getElementById('mapper-count').textContent = String(mappers.length);
            empty.hidden = mappers.length !== 0;
        } catch (err) { showError(`Could not load condition mappers: ${err.message}`); }
        finally { loading.hidden = true; }
    }

    const openModal = modal => modal.hidden = false;
    const closeModal = modal => modal.hidden = true;

    document.getElementById('open-create-mapper').addEventListener('click', () => {
        document.getElementById('create-mapper-form').reset();
        document.getElementById('create-mapper-example').value = '{}';
        openModal(createModal);
    });

    document.querySelectorAll('.mapper-close-modal').forEach(button => button.addEventListener('click', () => closeModal(button.closest('.modal'))));
    [createModal, editorModal, ruleModal].forEach(modal => modal.addEventListener('click', event => { if (event.target === modal) closeModal(modal); }));

    document.getElementById('create-mapper-form').addEventListener('submit', async event => {
        event.preventDefault();
        const submit = event.submitter;
        submit.disabled = true;
        clearError();
        try {
            const mapper = await api('/bot/mappers', {method: 'POST', body: JSON.stringify({key: document.getElementById('create-mapper-key').value.trim(),title: document.getElementById('create-mapper-title-input').value.trim(),description: document.getElementById('create-mapper-description').value.trim(),example: parseObject(document.getElementById('create-mapper-example').value, 'Example object'),rules: []})});
            closeModal(createModal);
            await loadMappers();
            openMapperEditor(mapper);
        } catch (err) { showError(err.message); }
        finally { submit.disabled = false; }
    });

    function openMapperEditor(mapper) {
        currentMapper = clone(mapper);
        document.getElementById('mapper-editor-title').textContent = mapper.title || mapper.key;
        document.getElementById('mapper-key-input').value = mapper.key || '';
        document.getElementById('mapper-title-input').value = mapper.title || '';
        document.getElementById('mapper-description-input').value = mapper.description || '';
        document.getElementById('mapper-example-input').value = JSON.stringify(mapper.example || {}, null, 2);
        document.getElementById('mapper-runtime-url').value = mapper.definitionKeyUrl || mapper.definitionUrl || `${location.origin}/m/key/${encodeURIComponent(mapper.key)}`;
        document.getElementById('mapper-test-output').textContent = '';
        refreshFieldList(mapper.example || {});
        renderRules();
        openModal(editorModal);
    }

    function collectMapperForm() {
        return {key: document.getElementById('mapper-key-input').value.trim(),title: document.getElementById('mapper-title-input').value.trim(),description: document.getElementById('mapper-description-input').value.trim(),example: parseObject(document.getElementById('mapper-example-input').value, 'Example object'),rules: currentMapper.rules || []};
    }

    async function saveCurrentMapper() {
        currentMapper = await api(`/bot/mappers/${encodeURIComponent(currentMapper.token)}`, {method: 'POST', body: JSON.stringify(collectMapperForm())});
        document.getElementById('mapper-editor-title').textContent = currentMapper.title || currentMapper.key;
        document.getElementById('mapper-runtime-url').value = currentMapper.definitionKeyUrl || currentMapper.definitionUrl;
        refreshFieldList(currentMapper.example);
        renderRules();
        await loadMappers();
        return currentMapper;
    }

    document.getElementById('save-mapper').addEventListener('click', async event => {
        event.currentTarget.disabled = true;
        clearError();
        try { await saveCurrentMapper(); event.currentTarget.textContent = 'Saved'; setTimeout(() => event.currentTarget.textContent = 'Save mapper', 900); }
        catch (err) { showError(err.message); }
        finally { event.currentTarget.disabled = false; }
    });

    document.getElementById('copy-mapper-runtime').addEventListener('click', event => copyText(document.getElementById('mapper-runtime-url').value, event.currentTarget));
    document.getElementById('mapper-example-input').addEventListener('input', () => { try { refreshFieldList(parseObject(document.getElementById('mapper-example-input').value, 'Example object')); } catch {} });

    document.getElementById('test-mapper').addEventListener('click', async event => {
        event.currentTarget.disabled = true;
        clearError();
        try {
            await saveCurrentMapper();
            const result = await api(`/bot/mappers/${encodeURIComponent(currentMapper.token)}/test`, {method: 'POST', body: JSON.stringify(currentMapper.example || {})});
            document.getElementById('mapper-test-output').textContent = JSON.stringify(result, null, 2);
        } catch (err) { showError(err.message); }
        finally { event.currentTarget.disabled = false; }
    });

    function actionButton(text, handler, className) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `button ${className} button-small`;
        button.textContent = text;
        button.addEventListener('click', handler);
        return button;
    }

    function renderRules() {
        const body = document.getElementById('mapper-rules-body');
        const rules = currentMapper?.rules || [];
        body.replaceChildren(...rules.map((rule, index) => {
            const row = document.createElement('tr');
            row.innerHTML = `<td class="priority-cell"></td><td><div class="rule-name"></div><div class="rule-summary"></div></td><td><div class="rule-action-summary"></div><div class="meta"><span class="badge rule-flow"></span></div></td><td><div class="rule-actions"></div></td>`;
            row.querySelector('.priority-cell').textContent = String(index + 1);
            row.querySelector('.rule-name').textContent = rule.name || `Rule ${index + 1}`;
            row.querySelector('.rule-summary').textContent = summarizeNode(rule.when);
            row.querySelector('.rule-action-summary').textContent = summarizeActions(rule);
            row.querySelector('.rule-flow').textContent = (rule.afterMatch || 'stop') === 'continue' ? 'continue after match' : 'stop after match';
            const actions = row.querySelector('.rule-actions');
            const up = actionButton('↑', () => moveRule(index, -1), 'button-secondary');
            const down = actionButton('↓', () => moveRule(index, 1), 'button-secondary');
            up.disabled = index === 0;
            down.disabled = index === rules.length - 1;
            actions.append(actionButton('Edit', () => openRuleEditor(index), 'button-primary'), up, down, actionButton('Delete', () => deleteRule(index), 'button-danger'));
            return row;
        }));
        document.getElementById('mapper-rules-empty').hidden = rules.length !== 0;
    }

    async function moveRule(index, delta) {
        const target = index + delta;
        if (target < 0 || target >= currentMapper.rules.length) return;
        [currentMapper.rules[index], currentMapper.rules[target]] = [currentMapper.rules[target], currentMapper.rules[index]];
        try { await saveCurrentMapper(); } catch (err) { showError(err.message); }
    }

    async function deleteRule(index) {
        if (!confirm(`Delete rule ${index + 1}?`)) return;
        currentMapper.rules.splice(index, 1);
        try { await saveCurrentMapper(); } catch (err) { showError(err.message); }
    }

    document.getElementById('add-mapper-rule').addEventListener('click', () => openRuleEditor(-1));

    function openRuleEditor(index) {
        currentRuleIndex = index;
        const rule = index >= 0 ? currentMapper.rules[index] : {name: '', when: newGroup(), actions: [newAction('set')], afterMatch: 'stop'};
        workingWhen = clone(rule.when || newGroup());
        workingActions = clone(rule.actions || resultToActions(rule.result));
        document.getElementById('mapper-rule-title').textContent = index >= 0 ? `Edit rule ${index + 1}` : 'New rule';
        document.getElementById('mapper-rule-name').value = rule.name || '';
        document.getElementById('mapper-rule-after-match').value = rule.afterMatch || 'stop';
        refreshFieldList();
        renderConditionTree();
        renderActions();
        openModal(ruleModal);
    }

    function renderConditionTree() {
        const root = document.getElementById('mapper-condition-tree');
        root.replaceChildren();
        renderGroup(workingWhen, root, true, null, -1, renderConditionTree);
    }

    function renderGroup(group, parent, isRoot, parentGroup, parentIndex, rerender) {
        const wrapper = document.createElement('div');
        wrapper.className = 'condition-group';
        const header = document.createElement('div');
        header.className = 'condition-group-header';
        const label = document.createElement('span');
        label.textContent = isRoot ? 'Match' : 'Group';
        const mode = document.createElement('select');
        mode.className = 'condition-mode';
        mode.innerHTML = '<option value="and">ALL (AND)</option><option value="or">ANY (OR)</option>';
        mode.value = group.op || 'and';
        mode.addEventListener('change', () => group.op = mode.value);
        header.append(label, mode, actionButton('+ Condition', () => { group.children.push(newCondition()); rerender(); }, 'button-secondary'), actionButton('+ Group', () => { group.children.push(newGroup()); rerender(); }, 'button-secondary'));
        if (!isRoot) header.append(actionButton('Remove group', () => { parentGroup.children.splice(parentIndex, 1); rerender(); }, 'button-danger'));
        wrapper.append(header);

        const children = document.createElement('div');
        children.className = 'condition-children';
        group.children.forEach((child, index) => {
            if (child.type === 'group') return renderGroup(child, children, false, group, index, rerender);
            const row = document.createElement('div');
            row.className = 'condition-row';
            const field = document.createElement('input');
            field.setAttribute('list', 'mapper-field-options');
            field.placeholder = 'field';
            field.value = child.field || '';
            const value = document.createElement('input');
            const updatePlaceholder = () => { const sample = getPath(getEditorExample(), field.value.trim()); value.placeholder = sample === undefined ? 'value' : `example: ${compactExample(sample)}`; };
            field.addEventListener('input', () => { child.field = field.value; updatePlaceholder(); });
            const operator = document.createElement('select');
            Object.entries(operatorLabels).forEach(([operatorValue, text]) => { const option = document.createElement('option'); option.value = operatorValue; option.textContent = text; operator.append(option); });
            operator.value = child.operator || 'eq';
            value.value = formatValue(child.value);
            value.addEventListener('input', () => child.value = value.value);
            operator.addEventListener('change', () => { child.operator = operator.value; value.hidden = unaryOperators.has(operator.value); });
            value.hidden = unaryOperators.has(operator.value);
            updatePlaceholder();
            row.append(field, operator, value, actionButton('×', () => { group.children.splice(index, 1); rerender(); }, 'button-danger'));
            children.append(row);
        });
        if (!group.children.length) {
            const empty = document.createElement('div');
            empty.className = 'condition-empty';
            empty.textContent = group.op === 'and' ? 'No conditions: this group always matches.' : 'No conditions: this group never matches.';
            children.append(empty);
        }
        wrapper.append(children);
        parent.append(wrapper);
    }

    function expressionType(expr) {
        if (expr?.type === 'op') return expr.op;
        return expr?.type || 'const';
    }

    function replaceExpression(target, replacement) {
        Object.keys(target).forEach(key => delete target[key]);
        Object.assign(target, replacement);
    }

    function renderExpression(expr, parent, rerender) {
        const node = document.createElement('div');
        node.className = 'expression-node';
        const type = document.createElement('select');
        type.className = 'expression-type';
        Object.entries(expressionTypes).forEach(([value, text]) => { const option = document.createElement('option'); option.value = value; option.textContent = text; type.append(option); });
        type.value = expressionType(expr);
        type.addEventListener('change', () => { replaceExpression(expr, newExpression(type.value)); rerender(); });
        node.append(type);

        if (expr.type === 'const') {
            const value = document.createElement('input');
            value.placeholder = 'constant: text, number, true, null, JSON…';
            value.value = formatValue(expr.value);
            value.addEventListener('input', () => expr.value = value.value);
            node.append(value);
        } else if (expr.type === 'field') {
            const field = document.createElement('input');
            field.setAttribute('list', 'mapper-field-options');
            field.placeholder = 'input field';
            field.value = expr.path || '';
            field.addEventListener('input', () => expr.path = field.value);
            node.append(field);
        } else if (expr.type === 'op') {
            const args = document.createElement('div');
            args.className = 'expression-args';
            (expr.args || []).forEach((arg, index) => {
                const argRow = document.createElement('div');
                argRow.className = 'expression-arg';
                renderExpression(arg, argRow, rerender);
                if ((expr.args || []).length > 1) argRow.append(actionButton('×', () => { expr.args.splice(index, 1); rerender(); }, 'button-danger'));
                args.append(argRow);
            });
            args.append(actionButton('+ Operand', () => { expr.args.push(newExpression('const')); rerender(); }, 'button-secondary'));
            node.append(args);
        } else if (expr.type === 'conditional') {
            const conditional = document.createElement('div');
            conditional.className = 'expression-conditional';
            const conditionLabel = document.createElement('div'); conditionLabel.className = 'expression-subtitle'; conditionLabel.textContent = 'IF';
            const condition = document.createElement('div');
            renderGroup(expr.when || (expr.when = newGroup()), condition, true, null, -1, rerender);
            const thenLabel = document.createElement('div'); thenLabel.className = 'expression-subtitle'; thenLabel.textContent = 'THEN';
            const thenNode = document.createElement('div'); renderExpression(expr.then || (expr.then = newExpression('const')), thenNode, rerender);
            const elseLabel = document.createElement('div'); elseLabel.className = 'expression-subtitle'; elseLabel.textContent = 'ELSE';
            const elseNode = document.createElement('div'); renderExpression(expr.else || (expr.else = newExpression('const')), elseNode, rerender);
            conditional.append(conditionLabel, condition, thenLabel, thenNode, elseLabel, elseNode);
            node.append(conditional);
        }
        parent.append(node);
    }

    function renderActions() {
        const root = document.getElementById('mapper-actions-list');
        root.replaceChildren(...workingActions.map((action, index) => {
            const card = document.createElement('div');
            card.className = 'mapper-action-card';
            const header = document.createElement('div');
            header.className = 'mapper-action-header';
            const type = document.createElement('select');
            type.innerHTML = '<option value="set">Set field</option><option value="unset">Unset field</option>';
            type.value = action.type || 'set';
            type.addEventListener('change', () => {
                const field = action.field || '';
                workingActions[index] = type.value === 'unset' ? {type: 'unset', field} : {type: 'set', field, value: newExpression('const')};
                renderActions();
            });
            const field = document.createElement('input');
            field.setAttribute('list', 'mapper-field-options');
            field.placeholder = 'target field';
            field.value = action.field || '';
            field.addEventListener('input', () => action.field = field.value);
            header.append(type, field, actionButton('Remove', () => { workingActions.splice(index, 1); renderActions(); }, 'button-danger'));
            card.append(header);
            if ((action.type || 'set') === 'set') {
                const expression = document.createElement('div');
                expression.className = 'mapper-action-expression';
                const label = document.createElement('div');
                label.className = 'expression-subtitle';
                label.textContent = 'Value / expression';
                expression.append(label);
                renderExpression(action.value || (action.value = newExpression('const')), expression, renderActions);
                card.append(expression);
            }
            return card;
        }));
        document.getElementById('mapper-actions-empty').hidden = workingActions.length !== 0;
    }

    document.getElementById('add-set-action').addEventListener('click', () => { workingActions.push(newAction('set')); renderActions(); });
    document.getElementById('add-unset-action').addEventListener('click', () => { workingActions.push(newAction('unset')); renderActions(); });

    document.getElementById('mapper-rule-form').addEventListener('submit', async event => {
        event.preventDefault();
        const submit = event.submitter;
        submit.disabled = true;
        clearError();
        try {
            const example = parseObject(document.getElementById('mapper-example-input').value, 'Example object');
            const actions = workingActions.map((action, index) => {
                const field = String(action.field || '').trim();
                if (!field) throw new Error(`Action ${index + 1} needs a target field.`);
                if (action.type === 'unset') return {type: 'unset', field};
                return {type: 'set', field, value: coerceExpression(action.value, example)};
            });
            const rule = {
                name: document.getElementById('mapper-rule-name').value.trim(),
                when: coerceNode(workingWhen, example),
                actions,
                afterMatch: document.getElementById('mapper-rule-after-match').value
            };
            if (currentRuleIndex >= 0) currentMapper.rules[currentRuleIndex] = rule;
            else currentMapper.rules.push(rule);
            await saveCurrentMapper();
            closeModal(ruleModal);
        } catch (err) { showError(err.message); }
        finally { submit.disabled = false; }
    });

    loadMappers();
})();
