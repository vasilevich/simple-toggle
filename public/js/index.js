(() => {
    const params = new URLSearchParams(location.search);
    let token = params.get('token');
    let adminMode = params.get('admin_mode');

    if (!token) {
        showTokenPrompt();
        return;
    }

    if (adminMode === null) {
        adminMode = 'true';
        params.set('admin_mode', adminMode);
        history.replaceState(null, '', `${location.pathname}?${params.toString()}${location.hash}`);
    }

    const isAdmin = adminMode !== 'false';
    document.querySelectorAll('.admin-only').forEach(el => el.hidden = !isAdmin);

    const globalError = document.getElementById('global-error');
    const botPanel = document.getElementById('bot-control-panel');
    const valuePanel = document.getElementById('value-control-panel');

    function showError(message) {
        globalError.textContent = message;
        globalError.hidden = false;
    }

    function clearError() {
        globalError.hidden = true;
        globalError.textContent = '';
    }

    async function api(path, options = {}) {
        const headers = new Headers(options.headers || {});
        headers.set('Authorization', `Bearer ${token}`);
        if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

        const response = await fetch(path, {...options, headers});
        if (response.status === 401) {
            showTokenPrompt('That token was rejected.');
            throw new Error('Unauthorized');
        }
        if (!response.ok) {
            const text = await response.text();
            throw new Error(text || `Request failed (${response.status})`);
        }
        if (response.status === 204) return null;
        const type = response.headers.get('content-type') || '';
        return type.includes('application/json') ? response.json() : response.text();
    }

    function setCount(id, count) {
        document.getElementById(id).textContent = String(count);
    }

    function createToggleCard(bot) {
        const card = document.createElement('article');
        card.className = 'control-card';
        card.dataset.search = `${bot.botName || ''} ${bot.title || ''} ${bot.description || ''}`.toLowerCase();
        card.innerHTML = `
            <div class="control-card-header">
                <div><h3></h3><div class="meta"><span class="badge bot-name"></span></div></div>
                <label class="switch" title="Toggle status">
                    <input type="checkbox">
                    <span class="switch-track"></span>
                </label>
            </div>
            <p class="description"></p>
            <div class="card-actions admin-actions"></div>
        `;

        card.querySelector('h3').textContent = bot.title || bot.botName;
        card.querySelector('.bot-name').textContent = bot.botName;
        card.querySelector('.description').textContent = bot.description || 'No description';

        const checkbox = card.querySelector('input[type="checkbox"]');
        checkbox.checked = Boolean(bot.status);
        checkbox.addEventListener('change', async () => {
            const next = checkbox.checked;
            checkbox.disabled = true;
            clearError();
            try {
                await api(`/bot/${encodeURIComponent(bot.botName)}`, {
                    method: 'POST',
                    body: JSON.stringify({status: next})
                });
            } catch (err) {
                checkbox.checked = !next;
                if (err.message !== 'Unauthorized') showError(err.message);
            } finally {
                checkbox.disabled = false;
            }
        });

        if (isAdmin) {
            const remove = document.createElement('button');
            remove.className = 'button button-danger button-small';
            remove.type = 'button';
            remove.textContent = 'Delete';
            remove.addEventListener('click', async () => {
                if (!confirm(`Delete ${bot.botName}?`)) return;
                remove.disabled = true;
                try {
                    await api(`/bot/${encodeURIComponent(bot.botName)}`, {method: 'DELETE'});
                    card.remove();
                    setCount('bot-count', botPanel.children.length);
                    document.getElementById('bots-empty').hidden = botPanel.children.length !== 0;
                } catch (err) {
                    remove.disabled = false;
                    if (err.message !== 'Unauthorized') showError(err.message);
                }
            });
            card.querySelector('.admin-actions').append(remove);
        }
        return card;
    }

    function createValueCard(item) {
        const card = document.createElement('article');
        card.className = 'control-card';
        card.dataset.search = `${item.key || ''} ${item.botName || ''} ${item.description || ''} ${item.value || ''}`.toLowerCase();
        card.innerHTML = `
            <div class="control-card-header">
                <div><h3></h3><div class="meta"><span class="badge bot-name"></span></div></div>
                <span class="badge">value</span>
            </div>
            <p class="description"></p>
            <div class="value-row">
                <input class="value-input" type="text" aria-label="Value">
                <button class="button button-primary button-small save-value" type="button">Save</button>
            </div>
            <div class="card-actions">
                <a class="button button-secondary button-small open-value" target="_blank" rel="noopener">Open page</a>
                <button class="button button-secondary button-small copy-url" type="button">Copy API URL</button>
                <button class="button button-danger button-small delete-value" type="button">Delete</button>
            </div>
        `;

        card.querySelector('h3').textContent = item.key || '(unnamed)';
        card.querySelector('.bot-name').textContent = item.botName || 'none';
        card.querySelector('.description').textContent = item.description || 'No description';
        const input = card.querySelector('.value-input');
        input.value = item.value ?? '';

        const pageUrl = `/bot_value_set.html?valueToken=${encodeURIComponent(item.token)}&token=${encodeURIComponent(token)}`;
        const apiUrl = `${location.origin}/bot/get_value/${encodeURIComponent(item.token)}?token=${encodeURIComponent(token)}&only_value=true`;
        card.querySelector('.open-value').href = pageUrl;

        const save = card.querySelector('.save-value');
        save.addEventListener('click', async () => {
            save.disabled = true;
            clearError();
            try {
                await api(`/bot/set_value/${encodeURIComponent(item.token)}`, {
                    method: 'POST',
                    body: JSON.stringify({value: input.value})
                });
                save.textContent = 'Saved';
                setTimeout(() => save.textContent = 'Save', 900);
            } catch (err) {
                if (err.message !== 'Unauthorized') showError(err.message);
            } finally {
                save.disabled = false;
            }
        });

        card.querySelector('.copy-url').addEventListener('click', async event => {
            try {
                await navigator.clipboard.writeText(apiUrl);
                event.currentTarget.textContent = 'Copied';
                setTimeout(() => event.currentTarget.textContent = 'Copy API URL', 900);
            } catch {
                prompt('Copy this URL:', apiUrl);
            }
        });

        const remove = card.querySelector('.delete-value');
        remove.addEventListener('click', async () => {
            if (!confirm(`Delete value control ${item.key || '(unnamed)'}?`)) return;
            remove.disabled = true;
            try {
                await api(`/bot/delete_value/${encodeURIComponent(item.token)}`, {method: 'DELETE'});
                card.remove();
                setCount('value-count', valuePanel.children.length);
                document.getElementById('values-empty').hidden = valuePanel.children.length !== 0;
            } catch (err) {
                remove.disabled = false;
                if (err.message !== 'Unauthorized') showError(err.message);
            }
        });

        return card;
    }

    async function loadToggles() {
        const loading = document.getElementById('bots-loading');
        const empty = document.getElementById('bots-empty');
        try {
            const bots = await api('/bots');
            botPanel.replaceChildren(...bots.map(createToggleCard));
            setCount('bot-count', bots.length);
            empty.hidden = bots.length !== 0;
        } catch (err) {
            if (err.message !== 'Unauthorized') showError(`Could not load toggles: ${err.message}`);
        } finally {
            loading.hidden = true;
        }
    }

    async function loadValues() {
        const loading = document.getElementById('values-loading');
        const empty = document.getElementById('values-empty');
        try {
            const values = await api('/bot/values');
            valuePanel.replaceChildren(...values.map(createValueCard));
            setCount('value-count', values.length);
            empty.hidden = values.length !== 0;
        } catch (err) {
            if (err.message !== 'Unauthorized') showError(`Could not load value controls: ${err.message}`);
        } finally {
            loading.hidden = true;
        }
    }

    document.querySelectorAll('.tab-button').forEach(button => {
        button.addEventListener('click', () => {
            document.querySelectorAll('.tab-button').forEach(el => el.classList.remove('active'));
            document.querySelectorAll('.tab-panel').forEach(el => el.classList.remove('active'));
            button.classList.add('active');
            document.getElementById(`tab-${button.dataset.tab}`).classList.add('active');
        });
    });

    document.getElementById('search-input').addEventListener('input', event => {
        const query = event.target.value.trim().toLowerCase();
        document.querySelectorAll('.control-card').forEach(card => {
            card.hidden = Boolean(query) && !card.dataset.search.includes(query);
        });
    });

    document.getElementById('change-token-button').addEventListener('click', () => showTokenPrompt());

    function bindModal(modalId, openerId) {
        const modal = document.getElementById(modalId);
        document.getElementById(openerId).addEventListener('click', () => modal.hidden = false);
        modal.querySelectorAll('.close-modal').forEach(button => button.addEventListener('click', () => modal.hidden = true));
        modal.addEventListener('click', event => {
            if (event.target === modal) modal.hidden = true;
        });
    }

    if (isAdmin) {
        bindModal('create-toggle-modal', 'open-create-toggle');
        bindModal('create-value-modal', 'open-create-value');
    }

    document.getElementById('create-toggle-form').addEventListener('submit', async event => {
        event.preventDefault();
        const submit = event.submitter;
        submit.disabled = true;
        const botName = document.getElementById('bot-name-input').value.trim();
        try {
            await api(`/bot/${encodeURIComponent(botName)}`, {
                method: 'POST',
                body: JSON.stringify({
                    status: false,
                    title: document.getElementById('bot-title-input').value.trim(),
                    description: document.getElementById('bot-description-input').value.trim()
                })
            });
            event.target.reset();
            document.getElementById('create-toggle-modal').hidden = true;
            document.getElementById('bots-loading').hidden = false;
            await loadToggles();
        } catch (err) {
            if (err.message !== 'Unauthorized') showError(err.message);
        } finally {
            submit.disabled = false;
        }
    });

    document.getElementById('create-value-form').addEventListener('submit', async event => {
        event.preventDefault();
        const submit = event.submitter;
        submit.disabled = true;
        try {
            await api('/bot/generate_link', {
                method: 'POST',
                body: JSON.stringify({
                    key: document.getElementById('value-key-input').value.trim(),
                    bot_name: document.getElementById('value-bot-input').value.trim() || 'none',
                    value: document.getElementById('value-initial-input').value,
                    description: document.getElementById('value-description-input').value.trim()
                })
            });
            event.target.reset();
            document.getElementById('create-value-modal').hidden = true;
            document.getElementById('values-loading').hidden = false;
            await loadValues();
            document.querySelector('[data-tab="values"]').click();
        } catch (err) {
            if (err.message !== 'Unauthorized') showError(err.message);
        } finally {
            submit.disabled = false;
        }
    });

    Promise.all([loadToggles(), loadValues()]);

    function showTokenPrompt(message = '') {
        document.body.innerHTML = `
            <main class="login-shell">
                <section class="login-card">
                    <div class="eyebrow">SIMPLE TOGGLE</div>
                    <h1>Access token</h1>
                    <p>Enter the server token to open the control panel.</p>
                    <div id="login-error" class="alert alert-error" ${message ? '' : 'hidden'}></div>
                    <form id="token-form">
                        <input id="token-input" type="password" placeholder="Token" autocomplete="current-password" required>
                        <button class="button button-primary" type="submit">Continue</button>
                    </form>
                </section>
            </main>`;
        const error = document.getElementById('login-error');
        if (message) error.textContent = message;
        document.getElementById('token-form').addEventListener('submit', event => {
            event.preventDefault();
            const nextToken = document.getElementById('token-input').value.trim();
            if (!nextToken) return;
            const nextParams = new URLSearchParams(location.search);
            nextParams.set('token', nextToken);
            if (!nextParams.has('admin_mode')) nextParams.set('admin_mode', 'true');
            location.replace(`${location.pathname}?${nextParams.toString()}${location.hash}`);
        });
        document.getElementById('token-input').focus();
    }
})();
