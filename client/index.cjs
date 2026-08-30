class BotControl {
    static url = '';
    static token = '';

    constructor(botName) {
        this.botName = botName;
    }

    static configure(config, token) {
        if (typeof config === 'string') config = {url: config, token};
        const url = config?.url;
        const accessToken = config?.token;
        if (!url || !accessToken) throw new TypeError('BotControl.configure requires both url and token');
        this.url = String(url).replace(/\/+$/, '');
        this.token = String(accessToken);
        return this;
    }

    static init(url, token) {
        return this.configure(url, token);
    }

    static ensureConfigured() {
        if (!this.url || !this.token) throw new Error('BotControl is not configured. Call BotControl.configure({ url, token }) first.');
        if (typeof globalThis.fetch !== 'function') throw new Error('BotControl requires Node.js 18+ or an environment with global fetch().');
    }

    static getAuthorizationHeader() {
        this.ensureConfigured();
        return {Authorization: `Bearer ${this.token}`};
    }

    static buildUrl(path) {
        this.ensureConfigured();
        if (/^https?:\/\//i.test(path)) return path;
        return `${this.url}/${String(path).replace(/^\/+/, '')}`;
    }

    static async request(fullUrl, options = {}) {
        const headers = {...(options.headers || {}), ...this.getAuthorizationHeader()};
        const response = await fetch(this.buildUrl(fullUrl), {...options, headers});
        const text = await response.text();
        let data = null;
        if (text) {
            try {
                data = JSON.parse(text);
            } catch {
                data = text;
            }
        }
        return {data, http_code: response.status, ok: response.ok};
    }

    static result({data, http_code, ok}) {
        if (Array.isArray(data)) return {data, http_code, ok};
        if (data && typeof data === 'object') return {...data, http_code, ok};
        return {data, http_code, ok};
    }

    static async getRequest(fullUrl) {
        return this.result(await this.request(fullUrl));
    }

    static async deleteRequest(fullUrl) {
        return this.result(await this.request(fullUrl, {method: 'DELETE'}));
    }

    static async postRequest(fullUrl, obj) {
        return this.result(await this.request(fullUrl, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(obj ?? {})
        }));
    }

    static async getValues() {
        const result = await this.request('/bot/values');
        if (!result.ok) throw Object.assign(new Error(`Unable to load values (${result.http_code})`), result);
        return Array.isArray(result.data) ? result.data : [];
    }

    static async getValuesMap() {
        const values = await this.getValues();
        return Object.fromEntries([...values].reverse().filter(item => item.key != null).map(item => [item.key, item.value]));
    }

    static async getValuesByBot(botName) {
        return (await this.getValues()).filter(item => item.botName === botName || item.bot_name === botName);
    }

    static async findValue(key, botName = null) {
        return (await this.getValues()).find(item => item.key === key && (botName == null || item.botName === botName || item.bot_name === botName)) || null;
    }

    static async getValueByKey(key, defaultValue = null, botName = null) {
        const item = await this.findValue(key, botName);
        return item?.value ?? defaultValue;
    }

    static async setValueByKey(key, value, botName = null) {
        const item = await this.findValue(key, botName);
        if (!item) return {error: 'Value control not found.', http_code: 404, ok: false};
        return this.setValue(item.token, value);
    }

    static async getBots() {
        const result = await this.request('/bots');
        if (!result.ok) throw Object.assign(new Error(`Unable to load bots (${result.http_code})`), result);
        return Array.isArray(result.data) ? result.data : [];
    }

    async generateUrl(key, description = '', value = '') {
        const Client = this.constructor;
        const json = await Client.postRequest('/bot/generate_link', {
            bot_name: this.botName,
            key,
            description,
            value
        });
        if (!json || json.http_code >= 400) return json;

        const base = `${String(json.url || Client.url).replace(/\/+$/, '')}/`;
        const resolve = path => path ? new URL(path, base).toString() : null;
        return {
            ...json,
            set_value_url: resolve(json.set_value_path),
            get_value_url: resolve(json.get_value_path),
            user_url: resolve(json.user_path)
        };
    }

    static async setValue(token, value) {
        return this.postRequest(`/bot/set_value/${encodeURIComponent(token)}`, {value});
    }

    static async getValue(token) {
        return this.getRequest(`/bot/get_value/${encodeURIComponent(token)}`);
    }

    static async getValueOnlyValue(token, defaultValue = null) {
        try {
            const obj = await this.getValue(token);
            return obj?.value ?? defaultValue;
        } catch {
            return defaultValue;
        }
    }

    static async getValueOnlyValueNoEmptyOrNull(token, defaultValue = null) {
        const result = await this.getValueOnlyValue(token, defaultValue);
        return typeof result === 'string' && result.trim() ? result : defaultValue;
    }

    static async deleteValue(token) {
        return this.deleteRequest(`/bot/delete_value/${encodeURIComponent(token)}`);
    }

    async getStatus() {
        return this.constructor.getRequest(`/bot/${encodeURIComponent(this.botName)}`);
    }

    async setStatus(status, extra = {}) {
        return this.constructor.postRequest(`/bot/${encodeURIComponent(this.botName)}`, {...extra, status: Boolean(status)});
    }

    async enable() {
        return this.setStatus(true);
    }

    async disable() {
        return this.setStatus(false);
    }

    async remove() {
        return this.constructor.deleteRequest(`/bot/${encodeURIComponent(this.botName)}`);
    }
}

module.exports = BotControl;
module.exports.BotControl = BotControl;
module.exports.default = BotControl;
