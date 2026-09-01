(() => {
    const params = new URLSearchParams(location.search);
    const token = params.get('token');
    const panel = document.getElementById('history-rows');
    if (!token || !panel) return;

    const isAdmin = params.get('admin_mode') !== 'false';
    const loading = document.getElementById('history-loading');
    const empty = document.getElementById('history-empty');
    const error = document.getElementById('global-error');
    let loaded = false;
    let mcpLoaded = false;

    const showError = message => { error.textContent = message; error.hidden = false; };
    const clearError = () => { error.textContent = ''; error.hidden = true; };

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

    function formatDate(value) {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? String(value || '') : date.toLocaleString();
    }

    function jsonBlock(label, value) {
        const wrapper = document.createElement('div');
        const strong = document.createElement('strong');
        strong.textContent = label;
        const pre = document.createElement('pre');
        pre.textContent = value == null ? '(none)' : JSON.stringify(value, null, 2);
        wrapper.append(strong, pre);
        return wrapper;
    }

    async function revertEntry(entry, button, returnHash) {
        if (!confirm(`Revert ${entry.label || entry.controlId} to the state before this change?`)) return;
        button.disabled = true;
        clearError();
        try {
            await api(`/bot/history/${entry.id}/revert`, {method: 'POST', body: '{}'});
            location.hash = returnHash;
            location.reload();
        } catch (err) {
            showError(err.message);
            button.disabled = false;
        }
    }

    function createHistoryRow(entry) {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td class="history-time"></td>
            <td><div class="history-label"></div><div class="meta"><span class="badge history-type"></span><span class="badge history-source"></span></div></td>
            <td><span class="badge history-action"></span></td>
            <td class="history-change"><code class="history-from"></code><span>→</span><code class="history-to"></code></td>
            <td class="history-actions"></td>
        `;
        row.querySelector('.history-time').textContent = formatDate(entry.createdAt);
        row.querySelector('.history-label').textContent = entry.label || entry.controlId;
        row.querySelector('.history-type').textContent = entry.type;
        row.querySelector('.history-source').textContent = entry.source;
        row.querySelector('.history-action').textContent = entry.action;
        row.querySelector('.history-from').textContent = entry.from;
        row.querySelector('.history-to').textContent = entry.to;

        const actions = row.querySelector('.history-actions');
        const revert = document.createElement('button');
        revert.className = 'button button-secondary button-small';
        revert.type = 'button';
        revert.textContent = 'Revert';
        revert.addEventListener('click', () => revertEntry(entry, revert, 'history'));

        const details = document.createElement('details');
        details.className = 'history-details';
        const summary = document.createElement('summary');
        summary.textContent = 'Details';
        const body = document.createElement('div');
        body.className = 'history-json-grid';
        body.append(jsonBlock('Before', entry.before), jsonBlock('After', entry.after));
        details.append(summary, body);
        actions.append(revert, details);
        return row;
    }

    async function loadHistory() {
        loading.hidden = false;
        empty.hidden = true;
        clearError();
        try {
            const rows = await api('/bot/history?limit=200');
            panel.replaceChildren(...rows.map(createHistoryRow));
            empty.hidden = rows.length !== 0;
            loaded = true;
        } catch (err) {
            showError(`Could not load history: ${err.message}`);
        } finally {
            loading.hidden = true;
        }
    }

    function openTab(name) {
        document.querySelectorAll('.tab-button').forEach(el => el.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach(el => el.classList.remove('active'));
        const button = document.querySelector(`[data-tab="${name}"]`);
        const section = document.getElementById(`tab-${name}`);
        if (button) button.classList.add('active');
        if (section) section.classList.add('active');
    }

    function mcpHistoryItem(entry) {
        const item = document.createElement('div');
        item.className = 'mcp-history-item';

        const time = document.createElement('div');
        time.className = 'mcp-time';
        time.textContent = formatDate(entry.createdAt);

        const control = document.createElement('div');
        control.innerHTML = '<div class="mcp-control"></div><div class="meta"><span class="badge mcp-type"></span><span class="badge mcp-action"></span></div>';
        control.querySelector('.mcp-control').textContent = entry.label || entry.controlId;
        control.querySelector('.mcp-type').textContent = entry.type;
        control.querySelector('.mcp-action').textContent = entry.action;

        const change = document.createElement('div');
        change.className = 'mcp-history-change';
        const from = document.createElement('code');
        const arrow = document.createElement('span');
        const to = document.createElement('code');
        from.textContent = entry.from;
        arrow.textContent = '→';
        to.textContent = entry.to;
        change.append(from, arrow, to);

        const actions = document.createElement('div');
        actions.className = 'mcp-history-actions';
        const revert = document.createElement('button');
        revert.className = 'button button-secondary button-small';
        revert.type = 'button';
        revert.textContent = 'Revert';
        revert.addEventListener('click', () => revertEntry(entry, revert, 'mcp'));

        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = 'JSON';
        const popover = document.createElement('div');
        popover.className = 'mcp-history-popover';
        popover.append(jsonBlock('Before', entry.before), jsonBlock('After', entry.after));
        details.append(summary, popover);
        actions.append(revert, details);

        item.append(time, control, change, actions);
        return item;
    }

    async function loadMcpHistory() {
        const list = document.getElementById('mcp-history-list');
        const state = document.getElementById('mcp-history-state');
        if (!list || !state) return;
        state.hidden = false;
        state.textContent = 'Loading MCP changes…';
        clearError();
        try {
            const rows = await api('/bot/history?limit=500');
            const mcpRows = rows.filter(entry => entry.source === 'mcp');
            list.replaceChildren(...mcpRows.map(mcpHistoryItem));
            state.textContent = mcpRows.length ? '' : 'No state-changing MCP actions recorded yet.';
            state.hidden = mcpRows.length !== 0;
            mcpLoaded = true;
        } catch (err) {
            state.hidden = true;
            showError(`Could not load MCP history: ${err.message}`);
        }
    }

    function setupMcpTab() {
        if (!isAdmin) return;

        const oldMcpCard = document.querySelector('#tab-history .mcp-card');
        if (oldMcpCard) oldMcpCard.remove();

        const historyButton = document.querySelector('[data-tab="history"]');
        if (!historyButton || document.querySelector('[data-tab="mcp"]')) return;

        const button = document.createElement('button');
        button.className = 'tab-button admin-only';
        button.dataset.tab = 'mcp';
        button.type = 'button';
        button.textContent = 'MCP';
        historyButton.before(button);

        const section = document.createElement('section');
        section.id = 'tab-mcp';
        section.className = 'tab-panel admin-only';
        section.innerHTML = `
            <div class="section-heading">
                <div><h2>MCP control plane</h2><p>Connect an AI client directly to Simple Toggle and audit the changes it makes.</p></div>
            </div>
            <div class="mcp-hero">
                <div class="mcp-info-card">
                    <h3>Connect an MCP client</h3>
                    <p>This server speaks Streamable HTTP MCP. The server instructions teach the client how toggles, values, mappers, history and revert work.</p>
                    <div class="mcp-endpoint-label">Endpoint <span class="mcp-status-pill">NO AUTH</span></div>
                    <div class="value-row"><input id="mcp-endpoint" readonly><button id="copy-mcp-endpoint" class="button button-primary" type="button">Copy</button></div>
                    <div class="mcp-warning"><strong>Full control:</strong> the MCP endpoint is intentionally unauthenticated. Anyone who can reach it can read and mutate Simple Toggle controls.</div>
                    <div class="mcp-capabilities">
                        <span class="mcp-capability">Find controls</span><span class="mcp-capability">Explain controls</span><span class="mcp-capability">Toggle on/off</span><span class="mcp-capability">Set values</span><span class="mcp-capability">Edit mappers</span><span class="mcp-capability">Test rules</span><span class="mcp-capability">History</span><span class="mcp-capability">Revert</span>
                    </div>
                </div>
                <div class="mcp-info-card">
                    <h3>How it behaves</h3>
                    <div class="mcp-facts">
                        <div class="mcp-fact"><strong>Transport</strong><span>Streamable HTTP MCP</span></div>
                        <div class="mcp-fact"><strong>Initialize</strong><span>Client POSTs <code>initialize</code> to the endpoint.</span></div>
                        <div class="mcp-fact"><strong>Documentation</strong><span>Detailed operating instructions are returned during initialization and via the MCP guide resource/tool.</span></div>
                        <div class="mcp-fact"><strong>Audit</strong><span>State-changing MCP tools write normal reversible history with source <code>mcp</code>.</span></div>
                        <div class="mcp-fact"><strong>Reads</strong><span>Search/list/get/explain calls are not logged because they do not change state.</span></div>
                    </div>
                </div>
            </div>
            <div class="mcp-history-heading">
                <div><h3>MCP changes</h3><p>Only mutations are shown here. Each one can be inspected and reverted.</p></div>
                <button id="refresh-mcp-history" class="button button-secondary" type="button">Refresh</button>
            </div>
            <div id="mcp-history-state" class="state-card">Loading MCP changes…</div>
            <div id="mcp-history-list" class="mcp-history-list"></div>
        `;
        document.getElementById('tab-history').before(section);

        const endpoint = `${location.origin}/mcp`;
        document.getElementById('mcp-endpoint').value = endpoint;
        document.getElementById('copy-mcp-endpoint').addEventListener('click', async event => {
            try { await navigator.clipboard.writeText(endpoint); }
            catch { prompt('Copy MCP endpoint:', endpoint); }
            const copy = event.currentTarget;
            copy.textContent = 'Copied';
            setTimeout(() => copy.textContent = 'Copy', 900);
        });
        document.getElementById('refresh-mcp-history').addEventListener('click', loadMcpHistory);
        button.addEventListener('click', () => {
            openTab('mcp');
            location.hash = 'mcp';
            if (!mcpLoaded) loadMcpHistory();
        });
    }

    function decorateValueCards() {
        const valuePanel = document.getElementById('value-control-panel');
        if (!valuePanel) return;
        valuePanel.querySelectorAll('.control-card:not([data-value-token-ready])').forEach(card => {
            const open = card.querySelector('.open-value');
            if (!open) return;
            let valueToken = '';
            try { valueToken = new URL(open.getAttribute('href'), location.origin).searchParams.get('valueToken') || ''; }
            catch { return; }
            if (!valueToken) return;

            card.dataset.valueTokenReady = 'true';
            const block = document.createElement('div');
            block.className = 'value-token-block';
            block.innerHTML = `
                <div class="value-token-heading"><strong>Permanent value access token</strong><span>read/write credential for /v/:token</span></div>
                <div class="value-token-row"><input class="value-token-input" readonly aria-label="Permanent value access token"><button class="button button-secondary button-small copy-value-token" type="button">Copy token</button></div>
            `;
            block.querySelector('.value-token-input').value = valueToken;
            block.querySelector('.copy-value-token').addEventListener('click', async event => {
                try { await navigator.clipboard.writeText(valueToken); }
                catch { block.querySelector('.value-token-input').select(); }
                const copy = event.currentTarget;
                copy.textContent = 'Copied';
                setTimeout(() => copy.textContent = 'Copy token', 900);
            });
            const cardActions = card.querySelector('.card-actions');
            if (cardActions) card.before ? cardActions.before(block) : card.append(block);
            else card.append(block);
        });
    }

    function enhanceMapperTable() {
        const table = document.querySelector('#mapper-editor-modal .mapper-table');
        const body = document.getElementById('mapper-rules-body');
        if (!table || !body) return;

        const header = table.querySelector('thead tr');
        if (header && !header.dataset.friendly) {
            header.dataset.friendly = 'true';
            const priority = document.createElement('th');
            const rule = document.createElement('th');
            const manage = document.createElement('th');
            priority.textContent = 'Order';
            rule.textContent = 'Rule';
            manage.textContent = 'Manage';
            header.replaceChildren(priority, rule, manage);
        }

        body.querySelectorAll('tr:not([data-friendly])').forEach(row => {
            if (row.children.length < 4) return;
            const priorityCell = row.children[0];
            const conditionCell = row.children[1];
            const resultCell = row.children[2];
            const manageCell = row.children[3];
            const name = conditionCell.querySelector('.rule-name')?.textContent || 'Rule';
            const condition = conditionCell.querySelector('.rule-summary')?.textContent || '(always)';
            const result = resultCell.querySelector('.rule-action-summary')?.textContent || '(no actions)';
            const flowText = resultCell.querySelector('.rule-flow')?.textContent || 'stop after match';
            const continues = flowText.toLowerCase().includes('continue');

            const friendly = document.createElement('td');
            friendly.className = 'rule-friendly-cell';
            const nameEl = document.createElement('div');
            nameEl.className = 'rule-friendly-name';
            nameEl.textContent = name;
            const logic = document.createElement('div');
            logic.className = 'rule-logic-flow';

            const conditionPill = document.createElement('div');
            conditionPill.className = 'rule-logic-pill rule-condition-pill';
            conditionPill.innerHTML = '<span class="rule-logic-kind">IF</span><span class="rule-logic-text"></span>';
            conditionPill.querySelector('.rule-logic-text').textContent = condition;

            const arrow = document.createElement('div');
            arrow.className = 'rule-logic-arrow';
            arrow.setAttribute('aria-hidden', 'true');
            arrow.textContent = '→';

            const resultPill = document.createElement('div');
            resultPill.className = 'rule-logic-pill rule-result-pill';
            resultPill.innerHTML = '<span class="rule-logic-kind">THEN</span><span class="rule-logic-text"></span>';
            resultPill.querySelector('.rule-logic-text').textContent = result;

            const flow = document.createElement('span');
            flow.className = `rule-flow-chip ${continues ? 'continue' : 'stop'}`;
            flow.textContent = continues ? 'CONTINUE' : 'STOP';
            logic.append(conditionPill, arrow, resultPill, flow);
            friendly.append(nameEl, logic);

            row.dataset.friendly = 'true';
            row.classList.add('mapper-rule-friendly');
            row.replaceChildren(priorityCell, friendly, manageCell);
        });
    }

    const valuePanel = document.getElementById('value-control-panel');
    if (valuePanel) {
        new MutationObserver(decorateValueCards).observe(valuePanel, {childList: true});
        decorateValueCards();
    }

    const mapperBody = document.getElementById('mapper-rules-body');
    if (mapperBody) {
        new MutationObserver(enhanceMapperTable).observe(mapperBody, {childList: true});
        enhanceMapperTable();
    }

    document.getElementById('refresh-history').addEventListener('click', loadHistory);
    document.querySelector('[data-tab="history"]').addEventListener('click', () => {
        location.hash = 'history';
        if (!loaded) loadHistory();
    });

    setupMcpTab();

    if (location.hash === '#history') document.querySelector('[data-tab="history"]').click();
    if (location.hash === '#mcp' && isAdmin) document.querySelector('[data-tab="mcp"]')?.click();
})();
