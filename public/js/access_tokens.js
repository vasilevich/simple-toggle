(() => {
    const params = new URLSearchParams(location.search);
    const adminToken = params.get('token');
    if (!adminToken) return;

    let mappers = [];
    let refreshTimer = null;

    async function fetchMappers() {
        const response = await fetch('/bot/mappers', {
            headers: {Authorization: `Bearer ${adminToken}`}
        });
        if (!response.ok) throw new Error(`Unable to load mapper tokens (${response.status})`);
        mappers = await response.json();
        decorateMapperCards();
        decorateMapperEditor();
    }

    async function copy(text, button) {
        try { await navigator.clipboard.writeText(text); }
        catch {
            const input = button?.closest('.value-token-row')?.querySelector('input');
            if (input) input.select();
            else prompt('Copy token:', text);
        }
        if (button) {
            const original = button.textContent;
            button.textContent = 'Copied';
            setTimeout(() => button.textContent = original, 900);
        }
    }

    function tokenBlock(mapper, className = '') {
        const block = document.createElement('div');
        block.className = `value-token-block mapper-token-block ${className}`.trim();
        block.innerHTML = `
            <div class="value-token-heading">
                <strong>🔑 Permanent mapper access token</strong>
                <span>use this exact token in getMapperByToken(...)</span>
            </div>
            <div class="value-token-row">
                <input class="mapper-token-input" readonly aria-label="Permanent mapper access token">
                <button class="button button-secondary button-small copy-mapper-token" type="button">Copy token</button>
            </div>
        `;
        block.querySelector('.mapper-token-input').value = mapper.token || mapper.accessToken || '';
        block.querySelector('.copy-mapper-token').addEventListener('click', event => copy(mapper.token || mapper.accessToken || '', event.currentTarget));
        return block;
    }

    function decorateMapperCards() {
        const panel = document.getElementById('mapper-control-panel');
        if (!panel) return;
        panel.querySelectorAll('.control-card').forEach(card => {
            const key = card.querySelector('.mapper-key')?.textContent?.trim();
            const mapper = mappers.find(item => item.key === key);
            if (!mapper) return;
            const existing = card.querySelector('.mapper-token-block');
            if (existing) {
                existing.querySelector('.mapper-token-input').value = mapper.token || mapper.accessToken || '';
                return;
            }
            const actions = card.querySelector('.card-actions');
            const block = tokenBlock(mapper);
            if (actions) actions.before(block);
            else card.append(block);
        });
    }

    function decorateMapperEditor() {
        const modal = document.getElementById('mapper-editor-modal');
        const keyInput = document.getElementById('mapper-key-input');
        const grid = modal?.querySelector('.mapper-meta-grid');
        if (!modal || !keyInput || !grid || modal.hidden) return;

        const mapper = mappers.find(item => item.key === keyInput.value.trim());
        if (!mapper) return;

        let block = grid.querySelector('.mapper-editor-token-block');
        if (!block) {
            block = tokenBlock(mapper, 'mapper-editor-token-block mapper-meta-wide');
            const definitionLabel = document.getElementById('mapper-runtime-url')?.closest('label');
            if (definitionLabel) grid.insertBefore(block, definitionLabel);
            else grid.append(block);
        } else {
            block.querySelector('.mapper-token-input').value = mapper.token || mapper.accessToken || '';
        }
    }

    function scheduleRefresh() {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => fetchMappers().catch(() => {}), 120);
    }

    const mapperPanel = document.getElementById('mapper-control-panel');
    if (mapperPanel) new MutationObserver(scheduleRefresh).observe(mapperPanel, {childList: true});

    const editor = document.getElementById('mapper-editor-modal');
    if (editor) new MutationObserver(() => {
        if (!editor.hidden) decorateMapperEditor();
    }).observe(editor, {attributes: true, attributeFilter: ['hidden']});

    document.getElementById('mapper-key-input')?.addEventListener('input', decorateMapperEditor);

    fetchMappers().catch(() => {});
})();
