const {MapperDefinition} = require('./mapper.cjs');

class BotControl {
    static url = '';
    static token = '';
    static mapperCache = new Map();
    static mapperRequests = new Map();
    static DEFAULT_TEMP_LINK_MINUTES = 7 * 24 * 60;

    constructor(botName) { this.botName = botName; }

    static configure(config, token) {
        if (typeof config === 'string') config = {url: config, token};
        const url = config?.url;
        const accessToken = config?.token;
        if (!url || !String(url).trim()) throw new TypeError('BotControl.configure requires url');
        this.url = String(url).trim().replace(/\/+$/, '');
        this.token = accessToken == null ? '' : String(accessToken).trim();
        this.clearCache();
        return this;
    }

    static init(url, token) { return this.configure(url, token); }
    static ensureConfigured(requireToken = false) {
        if (!this.url) throw new Error('BotControl is not configured. Call BotControl.configure({ url, token }) first.');
        if (requireToken && !this.token) throw new Error('Simple Toggle admin token is required for this operation.');
        if (typeof globalThis.fetch !== 'function') throw new Error('BotControl requires Node.js 18+ or an environment with global fetch().');
    }
    static getAuthorizationHeader() { this.ensureConfigured(true); return {Authorization: `Bearer ${this.token}`}; }
    static buildUrl(path) { this.ensureConfigured(); if (/^https?:\/\//i.test(path)) return path; return `${this.url}/${String(path).replace(/^\/+/, '')}`; }

    static async request(fullUrl, options = {}, useAdminToken = true) {
        const headers = {...(options.headers || {}), ...(useAdminToken ? this.getAuthorizationHeader() : {})};
        const response = await fetch(this.buildUrl(fullUrl), {...options, headers});
        const text = await response.text();
        let data = null;
        if (text) { try { data = JSON.parse(text); } catch { data = text; } }
        return {data, http_code: response.status, ok: response.ok, headers: response.headers};
    }
    static result({data, http_code, ok}) { if (Array.isArray(data)) return {data, http_code, ok}; if (data && typeof data === 'object') return {...data, http_code, ok}; return {data, http_code, ok}; }
    static async getRequest(fullUrl) { return this.result(await this.request(fullUrl)); }
    static async deleteRequest(fullUrl) { return this.result(await this.request(fullUrl, {method: 'DELETE'})); }
    static async postRequest(fullUrl, obj, useAdminToken = true) { return this.result(await this.request(fullUrl, {method: 'POST',headers: {'Content-Type': 'application/json'},body: JSON.stringify(obj ?? {})}, useAdminToken)); }

    static async getValues() { const result = await this.request('/bot/values'); if (!result.ok) throw Object.assign(new Error(`Unable to load values (${result.http_code})`), result); return Array.isArray(result.data) ? result.data : []; }
    static async getValuesMap() { const values = await this.getValues(); return Object.fromEntries([...values].reverse().filter(item => item.key != null).map(item => [item.key, item.value])); }
    static async getValuesByBot(botName) { return (await this.getValues()).filter(item => item.botName === botName || item.bot_name === botName); }
    static async findValue(key, botName = null) { return (await this.getValues()).find(item => item.key === key && (botName == null || item.botName === botName || item.bot_name === botName)) || null; }
    static async getValueByKey(key, defaultValue = null, botName = null) { const item = await this.findValue(key, botName); return item?.value ?? defaultValue; }
    static async setValueByKey(key, value, botName = null) { const item = await this.findValue(key, botName); if (!item) return {error: 'Value control not found.', http_code: 404, ok: false}; return this.setValue(item.token, value); }
    static getPermanentValueUrl(valueToken, onlyValue = false) { const suffix = onlyValue ? '?only_value=true' : ''; return this.buildUrl(`/v/${encodeURIComponent(valueToken)}${suffix}`); }
    static async createTemporarySetUrl(valueToken, expiresInMinutes = this.DEFAULT_TEMP_LINK_MINUTES) { return this.postRequest(`/bot/temp_link/${encodeURIComponent(valueToken)}`, {expires_in_minutes: expiresInMinutes}); }
    static async createTemporarySetUrlByKey(key, botName = null, expiresInMinutes = this.DEFAULT_TEMP_LINK_MINUTES) { const item = await this.findValue(key, botName); if (!item) return {error: 'Value control not found.', http_code: 404, ok: false}; return this.createTemporarySetUrl(item.token, expiresInMinutes); }

    /** Fetch once, then evaluate the returned definition locally for every row. */
    static async getMapper(key) {
        return this.mapperCache.get(key) || this.refreshMapper(key);
    }
    static async refreshMapper(key) {
        if (typeof key !== 'string' || !key.trim()) throw new TypeError('key is required');
        this.ensureConfigured(true);
        const cache = this.mapperCache, pending = this.mapperRequests;
        if (pending.has(key)) return pending.get(key);
        const task = this.fetchMapper(`/m/key/${encodeURIComponent(key)}`, cache.get(key), true).then(mapper => {
            // Reconfiguration/invalidation must not revive an obsolete in-flight request.
            if (this.mapperCache === cache && pending.get(key) === task) cache.set(key, mapper);
            return mapper;
        }).finally(() => { if (pending.get(key) === task) pending.delete(key); });
        pending.set(key, task);
        return task;
    }
    static async getMapperByToken(token) {
        if (typeof token !== 'string' || !token.trim()) throw new TypeError('token is required');
        return this.fetchMapper(`/m/${encodeURIComponent(token)}`, null, false);
    }
    static async fetchMapper(path, cached, useAdminToken) {
        const headers = {Accept: 'application/json'};
        if (cached?.getEtag()) headers['If-None-Match'] = cached.getEtag();
        const response = await this.request(path, {headers}, useAdminToken);
        if (response.http_code === 304 && cached) return cached;
        if (!response.ok) throw Object.assign(new Error(`Unable to load mapper definition (${response.http_code})`), response);
        return new MapperDefinition(response.data, response.headers.get('etag'));
    }
    static invalidate(key) { this.mapperCache.delete(key); this.mapperRequests.delete(key); }
    static clearCache() { this.mapperCache = new Map(); this.mapperRequests = new Map(); }

    static async getMappers() { const result = await this.request('/bot/mappers'); if (!result.ok) throw Object.assign(new Error(`Unable to load mappers (${result.http_code})`), result); return Array.isArray(result.data) ? result.data : []; }
    static async findMapper(key) { return (await this.getMappers()).find(item => item.key === key) || null; }
    static async createMapper(config) { return this.postRequest('/bot/mappers', config); }
    static async updateMapper(mapperToken, config) { return this.postRequest(`/bot/mappers/${encodeURIComponent(mapperToken)}`, config); }
    static async deleteMapper(mapperToken) { return this.deleteRequest(`/bot/mappers/${encodeURIComponent(mapperToken)}`); }
    static getMapperUrl(mapperToken, {merge = false, meta = false} = {}) {
        const query = new URLSearchParams();
        if (merge) query.set('merge', 'true');
        if (meta) query.set('meta', 'true');
        const suffix = query.toString();
        return this.buildUrl(`/m/${encodeURIComponent(mapperToken)}${suffix ? `?${suffix}` : ''}`);
    }
    static async mapRequest(mapperToken, input, options = {}) { const result = await this.request(this.getMapperUrl(mapperToken, options), {method: 'POST',headers: {'Content-Type': 'application/json'},body: JSON.stringify(input ?? {})}, false); return this.result(result); }
    static async map(mapperToken, input, options = {}) { const result = await this.request(this.getMapperUrl(mapperToken, options), {method: 'POST',headers: {'Content-Type': 'application/json'},body: JSON.stringify(input ?? {})}, false); if (!result.ok) throw Object.assign(new Error(`Unable to evaluate mapper (${result.http_code})`), result); return result.data; }
    static async applyMap(mapperToken, input) { return this.map(mapperToken, input, {merge: true}); }
    static async mapByKey(key, input, options = {}) { const mapper = await this.findMapper(key); if (!mapper) throw Object.assign(new Error('Condition mapper not found.'), {http_code: 404, ok: false}); return this.map(mapper.token, input, options); }
    static async applyMapByKey(key, input) { return this.mapByKey(key, input, {merge: true}); }

    static async getBots() { const result = await this.request('/bots'); if (!result.ok) throw Object.assign(new Error(`Unable to load bots (${result.http_code})`), result); return Array.isArray(result.data) ? result.data : []; }

    async generateUrl(key, description = '', value = '') {
        const Client = this.constructor;
        const json = await Client.postRequest('/bot/generate_link', {bot_name: this.botName,key,description,value});
        if (!json || json.http_code >= 400) return json;
        const base = `${String(json.url || Client.url).replace(/\/+$/, '')}/`;
        const resolve = path => path ? new URL(path, base).toString() : null;
        return {...json,permanent_access_token: json.access_token || json.token,set_value_url: resolve(json.set_value_path),get_value_url: resolve(json.get_value_path),user_url: resolve(json.user_path)};
    }
    async generateTemporaryUrl(key, description = '', value = '', expiresInMinutes = this.constructor.DEFAULT_TEMP_LINK_MINUTES) {
        const generated = await this.generateUrl(key, description, value);
        if (!generated || generated.http_code >= 400 || !generated.token) return generated;
        const temporary = await this.constructor.createTemporarySetUrl(generated.token, expiresInMinutes);
        return {...generated,temporary_url: temporary.url ?? null,temporary_code: temporary.code ?? null,temporary_expires_at: temporary.expires_at ?? null,temporary_http_code: temporary.http_code,temporary_ok: temporary.ok};
    }
    async generateTempUrl(...args) { return this.generateTemporaryUrl(...args); }

    static async setValue(token, value) { return this.postRequest(`/v/${encodeURIComponent(token)}`, {value}, false); }
    static async getValue(token) { return this.result(await this.request(`/v/${encodeURIComponent(token)}`, {}, false)); }
    static async getValueOnlyValue(token, defaultValue = null) { try { const obj = await this.getValue(token); return obj?.value ?? defaultValue; } catch { return defaultValue; } }
    static async getValueOnlyValueNoEmptyOrNull(token, defaultValue = null) { const result = await this.getValueOnlyValue(token, defaultValue); return typeof result === 'string' && result.trim() ? result : defaultValue; }
    static async deleteValue(token) { return this.deleteRequest(`/bot/delete_value/${encodeURIComponent(token)}`); }

    async getStatus() { return this.constructor.getRequest(`/bot/${encodeURIComponent(this.botName)}`); }
    async setStatus(status, extra = {}) { return this.constructor.postRequest(`/bot/${encodeURIComponent(this.botName)}`, {...extra, status: Boolean(status)}); }
    async enable() { return this.setStatus(true); }
    async disable() { return this.setStatus(false); }
    async remove() { return this.constructor.deleteRequest(`/bot/${encodeURIComponent(this.botName)}`); }
}

module.exports = BotControl;
module.exports.BotControl = BotControl;
module.exports.default = BotControl;
module.exports.MapperDefinition = MapperDefinition;
