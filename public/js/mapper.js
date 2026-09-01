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
    if (!isAdmin) document.getElementById('open-create-mapper').hidden = true;

    let mappers = [];
    let currentMapper = null;
    let currentRuleIndex = -1;
    let workingWhen = null;

    const clone = value => JSON.parse(JSON.stringify(value));
    const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const newCondition = () => ({type: 'condition', field: '', operator: 'eq', value: ''});
    const newGroup = () => ({type: 'group', op: 'and', children: [newCondition()]});

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
        return text;
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

    function summarizeNode(node) {
        if (!node) return '(always)';
        if (node.type === 'condition') return `${node.field || '?'} ${operatorLabels[node.operator] || node.operator} ${unaryOperators.has(node.operator) ? '' : formatValue(node.value)}`.trim();
        if (!node.children?.length) return '(always)';
        const glue = node.op === 'or' ? ' OR ' : ' AND ';
        return node.children.map(child => child.type === 'group' ? `(${summarizeNode(child)})` : summarizeNode(child)).join(glue);
    }

    async function copyText(text, button = null) {
        try { await navigator.clipboard.writeText(text); } catch { prompt('Copy this URL:', text); }
        if (button) { const original = button.textContent; button.textContent = 'Copied'; setTimeout(() => button.textContent = original, 900); }
    }

    function mapperCard(mapper) {
        const card = document.createElement('article');
        card.className = 'control-card';
        card.dataset.search = `${mapper.key || ''} ${mapper.title || ''} ${mapper.description || ''}`.toLowerCase();
        card.innerHTML = `<div class="control-card-header"><div><h3></h3><div class="meta"><span class="badge mapper-key"></span><span class="badge mapper-rules"></span></div></div><span class="badge">mapper</span></div><p class="description"></p><div class="card-actions"><button class="button button-primary button-small edit-mapper" type="button">Edit rules</button><button class="button button-secondary button-small copy-mapper" type="button">Copy runtime URL</button><button class="button button-danger button-small delete-mapper" type="button">Delete</button></div>`;
        card.querySelector('h3').textContent = mapper.title || mapper.key;
        card.querySelector('.mapper-key').textContent = mapper.key;
        card.querySelector('.mapper-rules').textContent = `${mapper.rules?.length || 0} rules`;
        card.querySelector('.description').textContent = mapper.description || 'No description';
        const editMapper = card.querySelector('.edit-mapper');
        if (!isAdmin) editMapper.hidden = true;
        editMapper.addEventListener('click', () => openMapperEditor(mapper));
        card.querySelector('.copy-mapper').addEventListener('click', event => copyText(mapper.runtimeUrl, event.currentTarget));
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
        document.getElementById('mapper-runtime-url').value = mapper.runtimeUrl || `${location.origin}/m/${mapper.token}`;
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
        document.getElementById('mapper-runtime-url').value = currentMapper.runtimeUrl;
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
            row.innerHTML = `<td class="priority-cell"></td><td><div class="rule-name"></div><div class="rule-summary"></div></td><td><code class="rule-result"></code></td><td><div class="rule-actions"></div></td>`;
            row.querySelector('.priority-cell').textContent = String(index + 1);
            row.querySelector('.rule-name').textContent = rule.name || `Rule ${index + 1}`;
            row.querySelector('.rule-summary').textContent = summarizeNode(rule.when);
            row.querySelector('.rule-result').textContent = JSON.stringify(rule.result || {});
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
        const rule = index >= 0 ? currentMapper.rules[index] : {name: '', when: newGroup(), result: {}};
        workingWhen = clone(rule.when || newGroup());
        document.getElementById('mapper-rule-title').textContent = index >= 0 ? `Edit rule ${index + 1}` : 'New rule';
        document.getElementById('mapper-rule-name').value = rule.name || '';
        document.getElementById('mapper-rule-result').value = JSON.stringify(rule.result || {}, null, 2);
        refreshFieldList();
        renderConditionTree();
        openModal(ruleModal);
    }

    function renderConditionTree() {
        const root = document.getElementById('mapper-condition-tree');
        root.replaceChildren();
        renderGroup(workingWhen, root, true, null, -1);
    }

    function renderGroup(group, parent, isRoot, parentGroup, parentIndex) {
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
        header.append(label, mode, actionButton('+ Condition', () => { group.children.push(newCondition()); renderConditionTree(); }, 'button-secondary'), actionButton('+ Group', () => { group.children.push(newGroup()); renderConditionTree(); }, 'button-secondary'));
        if (!isRoot) header.append(actionButton('Remove group', () => { parentGroup.children.splice(parentIndex, 1); renderConditionTree(); }, 'button-danger'));
        wrapper.append(header);

        const children = document.createElement('div');
        children.className = 'condition-children';
        group.children.forEach((child, index) => {
            if (child.type === 'group') return renderGroup(child, children, false, group, index);
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
            row.append(field, operator, value, actionButton('×', () => { group.children.splice(index, 1); renderConditionTree(); }, 'button-danger'));
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

    document.getElementById('mapper-rule-form').addEventListener('submit', async event => {
        event.preventDefault();
        const submit = event.submitter;
        submit.disabled = true;
        clearError();
        try {
            const example = parseObject(document.getElementById('mapper-example-input').value, 'Example object');
            const rule = {name: document.getElementById('mapper-rule-name').value.trim(),when: coerceNode(workingWhen, example),result: parseObject(document.getElementById('mapper-rule-result').value, 'Rule result')};
            if (currentRuleIndex >= 0) currentMapper.rules[currentRuleIndex] = rule;
            else currentMapper.rules.push(rule);
            await saveCurrentMapper();
            closeModal(ruleModal);
        } catch (err) { showError(err.message); }
        finally { submit.disabled = false; }
    });

    loadMappers();
})();
