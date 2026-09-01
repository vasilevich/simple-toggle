(() => {
    const params = new URLSearchParams(location.search);
    const token = params.get('token');
    const panel = document.getElementById('history-rows');
    if (!token || !panel) return;

    const loading = document.getElementById('history-loading');
    const empty = document.getElementById('history-empty');
    const error = document.getElementById('global-error');
    let loaded = false;

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
        revert.addEventListener('click', async () => {
            if (!confirm(`Revert ${entry.label || entry.controlId} to the state before this change?`)) return;
            revert.disabled = true;
            clearError();
            try {
                await api(`/bot/history/${entry.id}/revert`, {method: 'POST', body: '{}'});
                location.hash = 'history';
                location.reload();
            } catch (err) {
                showError(err.message);
                revert.disabled = false;
            }
        });

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

    const endpoint = `${location.origin}/mcp`;
    document.getElementById('mcp-endpoint').value = endpoint;
    document.getElementById('copy-mcp-endpoint').addEventListener('click', async event => {
        try { await navigator.clipboard.writeText(endpoint); }
        catch { prompt('Copy MCP endpoint:', endpoint); }
        const button = event.currentTarget;
        button.textContent = 'Copied';
        setTimeout(() => button.textContent = 'Copy', 900);
    });

    document.getElementById('refresh-history').addEventListener('click', loadHistory);
    document.querySelector('[data-tab="history"]').addEventListener('click', () => { if (!loaded) loadHistory(); });

    if (location.hash === '#history') {
        document.querySelector('[data-tab="history"]').click();
        loadHistory();
    }
})();
