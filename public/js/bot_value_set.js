(() => {
    const params = new URLSearchParams(location.search);
    const token = params.get('token');
    const valueToken = params.get('valueToken');
    const message = document.getElementById('page-message');
    const saveButton = document.getElementById('save-button');
    const valueUrl = `${location.origin}/bot/get_value/${encodeURIComponent(valueToken || '')}?token=${encodeURIComponent(token || '')}&only_value=true`;
    document.getElementById('value-url').value = valueUrl;

    function showMessage(text, success = false) {
        message.textContent = text;
        message.className = `alert ${success ? 'alert-success' : 'alert-error'}`;
        message.hidden = false;
    }

    async function request(path, options = {}) {
        const response = await fetch(path, {
            ...options,
            headers: {
                'Authorization': `Bearer ${token || ''}`,
                ...(options.body ? {'Content-Type': 'application/json'} : {}),
                ...(options.headers || {})
            }
        });
        if (!response.ok) throw new Error(await response.text() || `Request failed (${response.status})`);
        const type = response.headers.get('content-type') || '';
        return type.includes('application/json') ? response.json() : response.text();
    }

    if (!token || !valueToken) {
        showMessage('Missing token or valueToken in the URL.');
        saveButton.disabled = true;
        return;
    }

    request(`/bot/get_value/${encodeURIComponent(valueToken)}`)
        .then(data => {
            document.getElementById('key').textContent = data.key || '(unnamed)';
            document.getElementById('description').textContent = data.description || 'No description';
            document.getElementById('value').value = data.value ?? '';
        })
        .catch(err => {
            showMessage(err.message);
            saveButton.disabled = true;
        });

    document.getElementById('value-form').addEventListener('submit', async event => {
        event.preventDefault();
        saveButton.disabled = true;
        try {
            await request(`/bot/set_value/${encodeURIComponent(valueToken)}`, {
                method: 'POST',
                body: JSON.stringify({value: document.getElementById('value').value})
            });
            showMessage('Value saved.', true);
        } catch (err) {
            showMessage(err.message);
        } finally {
            saveButton.disabled = false;
        }
    });

    document.getElementById('copy-value-url').addEventListener('click', async event => {
        try {
            await navigator.clipboard.writeText(valueUrl);
            event.currentTarget.textContent = 'Copied';
            setTimeout(() => event.currentTarget.textContent = 'Copy', 900);
        } catch {
            document.getElementById('value-url').select();
        }
    });
})();
