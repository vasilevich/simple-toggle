(() => {
    const params = new URLSearchParams(location.search);
    const adminToken = params.get('token');
    if (!adminToken) return;

    let mappers = [];
    let refreshTimer = null;

    const ruleToggleStyle = document.createElement('style');
    ruleToggleStyle.textContent = `
        .rule-enabled-toggle {
            width: 24px;
            min-width: 24px;
            height: 24px;
            padding: 0;
            border: 0;
            border-radius: 999px;
            color: #fff;
            font: 800 12px/1 system-ui, sans-serif;
            display: inline-grid;
            place-items: center;
            cursor: pointer;
            box-shadow: inset 0 0 0 1px rgba(255,255,255,.22), 0 1px 2px rgba(0,0,0,.12);
        }
        .rule-enabled-toggle.enabled { background: var(--good); }
        .rule-enabled-toggle.disabled { background: var(--bad); }
        .rule-enabled-toggle:disabled { opacity: .5; cursor: wait; }
        .mapper-rule-disabled .rule-friendly-cell,
        .mapper-rule-disabled .rule-summary,
        .mapper-rule-disabled .rule-action-summary { opacity: .48; }
        .mapper-rule-disabled .rule-name::after,
        .mapper-rule-disabled .rule-friendly-name::after {
            content: ' disabled';
            margin-left: 7px;
            color: var(--bad);
            font-size: 10px;
            font-weight: 800;
            text-transform: uppercase;
            letter-spacing: .05em;
        }
    `;
    document.head.append(ruleToggleStyle);

    async function fetchMappers() {
        const response = await fetch('/bot/mappers', {
            headers: {Authorization: `Bearer ${adminToken}`}
        });
        if (!response.ok) throw new Error(`Unable to load mapper data (${response.status})`);
        mappers = await response.json();
        decorateMapperCards();
        decorateMapperEditor();
        decorateRuleButtons();
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

    function currentMapper() {
        const key = document.getElementById('mapper-key-input')?.value?.trim();
        if (!key) return null;
        return mappers.find(item => item.key === key) || null;
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

        const mapper = currentMapper();
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

    function setRuleButtonState(button, row, enabled) {
        button.classList.toggle('enabled', enabled);
        button.classList.toggle('disabled', !enabled);
        const text = enabled ? '✓' : '×';
        const title = enabled ? 'Rule enabled — click to disable' : 'Rule disabled — click to enable';
        if (button.textContent !== text) button.textContent = text;
        if (button.title !== title) button.title = title;
        if (button.getAttribute('aria-label') !== title) button.setAttribute('aria-label', title);
        row.classList.toggle('mapper-rule-disabled', !enabled);
    }

    function decorateRuleButtons() {
        const modal = document.getElementById('mapper-editor-modal');
        const body = document.getElementById('mapper-rules-body');
        if (!modal || modal.hidden || !body) return;
        const mapper = currentMapper();
        if (!mapper) return;

        Array.from(body.children).forEach((row, index) => {
            const actions = row.querySelector('.rule-actions');
            const rule = mapper.rules?.[index];
            if (!actions || !rule) return;

            let button = actions.querySelector('.rule-enabled-toggle');
            if (!button) {
                button = document.createElement('button');
                button.type = 'button';
                button.className = 'rule-enabled-toggle';
                actions.append(button);
                button.addEventListener('click', async () => {
                    const latestMapper = currentMapper();
                    const currentIndex = Array.from(body.children).indexOf(row);
                    const latestRule = latestMapper?.rules?.[currentIndex];
                    if (!latestMapper || !latestRule || currentIndex < 0) return;

                    const nextEnabled = latestRule.enabled === false;
                    button.disabled = true;
                    try {
                        const response = await fetch(`/bot/mappers/${encodeURIComponent(latestMapper.token)}/rules/${currentIndex}/enabled`, {
                            method: 'POST',
                            headers: {
                                Authorization: `Bearer ${adminToken}`,
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({enabled: nextEnabled})
                        });
                        const text = await response.text();
                        let updated = null;
                        if (text) { try { updated = JSON.parse(text); } catch {} }
                        if (!response.ok) throw new Error(updated?.error || text || `Unable to change rule (${response.status})`);

                        const mapperIndex = mappers.findIndex(item => item.token === latestMapper.token);
                        if (mapperIndex >= 0) mappers[mapperIndex] = updated;
                        decorateRuleButtons();
                    } catch (err) {
                        alert(err.message || String(err));
                    } finally {
                        button.disabled = false;
                    }
                });
            }
            setRuleButtonState(button, row, rule.enabled !== false);
        });
    }

    function scheduleRefresh() {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => fetchMappers().catch(() => {}), 120);
    }

    const mapperPanel = document.getElementById('mapper-control-panel');
    if (mapperPanel) new MutationObserver(scheduleRefresh).observe(mapperPanel, {childList: true});

    const editor = document.getElementById('mapper-editor-modal');
    if (editor) new MutationObserver(() => {
        if (!editor.hidden) {
            decorateMapperEditor();
            decorateRuleButtons();
        }
    }).observe(editor, {attributes: true, attributeFilter: ['hidden']});

    // Only observe direct rule-row replacement. Watching the whole subtree caused the decorator
    // to observe its own ✓/× button updates and spin when the mapper editor opened.
    const rulesBody = document.getElementById('mapper-rules-body');
    if (rulesBody) new MutationObserver(() => decorateRuleButtons()).observe(rulesBody, {childList: true});

    document.getElementById('mapper-key-input')?.addEventListener('input', () => {
        decorateMapperEditor();
        decorateRuleButtons();
    });

    fetchMappers().catch(() => {});
})();