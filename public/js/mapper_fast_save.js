(() => {
    const button = document.getElementById('save-mapper');
    if (!button) return;

    const params = new URLSearchParams(location.search);
    const adminToken = params.get('token');
    const errorBox = document.getElementById('global-error');

    function showError(message) {
        if (!errorBox) return;
        errorBox.textContent = message;
        errorBox.hidden = false;
    }

    function clearError() {
        if (!errorBox) return;
        errorBox.textContent = '';
        errorBox.hidden = true;
    }

    function mapperToken() {
        return document.querySelector('#mapper-editor-modal .mapper-editor-token-block .mapper-token-input')?.value?.trim()
            || document.querySelector('#mapper-editor-modal .mapper-token-input')?.value?.trim()
            || '';
    }

    function parseExample() {
        const text = document.getElementById('mapper-example-input')?.value || '{}';
        let value;
        try { value = JSON.parse(text); }
        catch (err) { throw new Error(`Example object is not valid JSON: ${err.message}`); }
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Example object must be a JSON object.');
        return value;
    }

    // Capture phase intentionally replaces mapper.js's older heavy Save handler.
    button.addEventListener('click', async event => {
        event.preventDefault();
        event.stopImmediatePropagation();

        const token = mapperToken();
        if (!token) {
            showError('Could not determine mapper access token. Close and reopen the mapper, then try again.');
            return;
        }

        const originalText = button.textContent;
        button.disabled = true;
        button.textContent = 'Saving…';
        clearError();

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 12000);
        try {
            const payload = {
                key: document.getElementById('mapper-key-input')?.value?.trim() || '',
                title: document.getElementById('mapper-title-input')?.value?.trim() || '',
                description: document.getElementById('mapper-description-input')?.value?.trim() || '',
                example: parseExample()
            };

            const response = await fetch(`/bot/mappers/${encodeURIComponent(token)}`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${adminToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload),
                signal: controller.signal
            });
            const text = await response.text();
            let data = null;
            if (text) { try { data = JSON.parse(text); } catch { data = text; } }
            if (!response.ok) throw new Error(data?.error || data || `Save failed (${response.status})`);

            if (data?.title || data?.key) document.getElementById('mapper-editor-title').textContent = data.title || data.key;
            if (data?.definitionKeyUrl || data?.definitionUrl) document.getElementById('mapper-runtime-url').value = data.definitionKeyUrl || data.definitionUrl;

            button.textContent = 'Saved';
            setTimeout(() => { if (!button.disabled) button.textContent = originalText; }, 900);
        } catch (err) {
            if (err?.name === 'AbortError') showError('Saving mapper timed out after 12 seconds. The server did not finish the request.');
            else showError(err?.message || String(err));
            button.textContent = originalText;
        } finally {
            clearTimeout(timeout);
            button.disabled = false;
        }
    }, true);
})();
