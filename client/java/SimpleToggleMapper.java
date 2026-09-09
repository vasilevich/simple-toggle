import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.math.BigDecimal;
import java.math.MathContext;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Dependency-free Java 8 client for values, toggles, and local/remote condition mappers.
 *
 * Typical usage:
 *
 *   SimpleToggleMapper simpleToggle = new SimpleToggleMapper(
 *       "https://toggle.example.com",
 *       System.getenv("SIMPLE_TOGGLE_TOKEN")
 *   );
 *   SimpleToggleMapper.MapperDefinition mapper = simpleToggle.getMapper("kish-orders-coupons");
 *
 *   // Fetch happens once. Reuse this object for every row.
 *   Map<String, Object> output = mapper.evaluate(order); // transformed copy
 *   mapper.apply(order);                                // or mutate the original map
 *
 * getMapper(key) is cached in memory. Call refreshMapper(key) when you want a conditional
 * HTTP revalidation; Simple Toggle supplies ETag/Last-Modified headers and returns 304 when unchanged.
 * Key-based mapper lookup uses the normal Simple Toggle Bearer token. Fetching by permanent mapper
 * token uses that mapper token as the credential and does not require the global admin token.
 */
public class SimpleToggleMapper {
    private final String baseUrl;
    private final String apiToken;
    private final Map<String, MapperDefinition> cache = new LinkedHashMap<String, MapperDefinition>();
    private int connectTimeoutMs = 10000;
    private int readTimeoutMs = 30000;

    /**
     * Creates a client without the global admin token. This can still use getMapperByToken(),
     * because the permanent mapper token is itself a credential.
     */
    public SimpleToggleMapper(String baseUrl) {
        this(baseUrl, null);
    }

    /** Creates a client that can fetch mapper definitions by key using the normal admin Bearer token. */
    public SimpleToggleMapper(String baseUrl, String apiToken) {
        if (baseUrl == null || baseUrl.trim().isEmpty()) throw new IllegalArgumentException("baseUrl is required");
        this.baseUrl = baseUrl.trim().replaceAll("/+$", "");
        this.apiToken = apiToken == null ? null : apiToken.trim();
    }

    public SimpleToggleMapper setTimeouts(int connectTimeoutMs, int readTimeoutMs) {
        if (connectTimeoutMs < 0 || readTimeoutMs < 0) throw new IllegalArgumentException("Timeouts must not be negative");
        this.connectTimeoutMs = connectTimeoutMs;
        this.readTimeoutMs = readTimeoutMs;
        return this;
    }

    public boolean hasAdminToken() { return apiToken != null && !apiToken.isEmpty(); }

    /** Returns the cached mapper, fetching it only when absent. Requires the admin token. */
    public synchronized MapperDefinition getMapper(String key) throws IOException {
        MapperDefinition cached = cache.get(key);
        if (cached != null) return cached;
        return refreshMapper(key);
    }

    /**
     * Revalidates the mapper over HTTP. If the server returns 304, the same cached instance is returned.
     * Use this on your own schedule (for example once per batch, every few minutes, etc.).
     * Requires the normal Simple Toggle admin token supplied to the constructor.
     */
    public synchronized MapperDefinition refreshMapper(String key) throws IOException {
        if (key == null || key.trim().isEmpty()) throw new IllegalArgumentException("key is required");
        if (!hasAdminToken()) throw new IllegalStateException("Simple Toggle admin token is required for getMapper/refreshMapper by key. Use new SimpleToggleMapper(baseUrl, token).");
        MapperDefinition cached = cache.get(key);
        String encoded = URLEncoder.encode(key, "UTF-8").replace("+", "%20");
        MapperDefinition fresh = fetch(baseUrl + "/m/key/" + encoded, cached, true);
        if (fresh != null) cache.put(key, fresh);
        return fresh != null ? fresh : cached;
    }

    /** Fetches a mapper by permanent mapper token. This does not require the global admin token. */
    public MapperDefinition getMapperByToken(String token) throws IOException {
        if (token == null || token.trim().isEmpty()) throw new IllegalArgumentException("token is required");
        String encoded = URLEncoder.encode(token, "UTF-8").replace("+", "%20");
        return fetch(baseUrl + "/m/" + encoded, null, false);
    }

    public synchronized void invalidate(String key) { cache.remove(key); }
    public synchronized void clearCache() { cache.clear(); }

    public static final int DEFAULT_TEMP_LINK_MINUTES = 7 * 24 * 60;

    // Direct values and administrative operations use the same endpoints as the JS client.
    public List<Map<String, Object>> getValues() throws IOException { return listRequest("/bot/values"); }
    public Map<String, Object> getValuesMap() throws IOException {
        List<Map<String, Object>> values = getValues();
        Map<String, Object> result = new LinkedHashMap<String, Object>();
        for (int i = values.size() - 1; i >= 0; i--) {
            Map<String, Object> item = values.get(i);
            if (item.get("key") != null) result.put(string(item.get("key")), item.get("value"));
        }
        return result;
    }
    public List<Map<String, Object>> getValuesByBot(String botName) throws IOException {
        List<Map<String, Object>> result = new ArrayList<Map<String, Object>>();
        for (Map<String, Object> item : getValues()) if (belongsToBot(item, botName)) result.add(item);
        return result;
    }
    public Map<String, Object> findValue(String key) throws IOException { return findValue(key, null); }
    public Map<String, Object> findValue(String key, String botName) throws IOException {
        for (Map<String, Object> item : getValues())
            if (java.util.Objects.equals(key, item.get("key")) && (botName == null || belongsToBot(item, botName))) return item;
        return null;
    }
    public Object getValueByKey(String key) throws IOException { return getValueByKey(key, null, null); }
    public Object getValueByKey(String key, Object defaultValue) throws IOException { return getValueByKey(key, defaultValue, null); }
    public Object getValueByKey(String key, Object defaultValue, String botName) throws IOException {
        Map<String, Object> item = findValue(key, botName);
        return item == null || item.get("value") == null ? defaultValue : item.get("value");
    }
    public Map<String, Object> setValueByKey(String key, Object value) throws IOException { return setValueByKey(key, value, null); }
    public Map<String, Object> setValueByKey(String key, Object value, String botName) throws IOException {
        Map<String, Object> item = findValue(key, botName);
        return item == null ? valueNotFound() : setValue(string(item.get("token")), value);
    }
    public Map<String, Object> getValue(String token) throws IOException { return request("/v/" + encode(token), "GET", null, false, null).result(); }
    public Map<String, Object> setValue(String token, Object value) throws IOException { return request("/v/" + encode(token), "POST", object("value", value), false, null).result(); }
    public Map<String, Object> deleteValue(String token) throws IOException { return deleteRequest("/bot/delete_value/" + encode(token)); }
    public Object getValueOnlyValue(String token) { return getValueOnlyValue(token, null); }
    public Object getValueOnlyValue(String token, Object defaultValue) {
        try { Object value = getValue(token).get("value"); return value == null ? defaultValue : value; }
        catch (IOException ex) { return defaultValue; }
    }
    public Object getValueOnlyValueNoEmptyOrNull(String token) { return getValueOnlyValueNoEmptyOrNull(token, null); }
    public Object getValueOnlyValueNoEmptyOrNull(String token, Object defaultValue) {
        Object value = getValueOnlyValue(token, defaultValue);
        return value instanceof String && !((String) value).trim().isEmpty() ? value : defaultValue;
    }
    public String getPermanentValueUrl(String token) throws IOException { return getPermanentValueUrl(token, false); }
    public String getPermanentValueUrl(String token, boolean onlyValue) throws IOException { return buildUrl("/v/" + encode(token) + (onlyValue ? "?only_value=true" : "")); }
    public Map<String, Object> createTemporarySetUrl(String token) throws IOException { return createTemporarySetUrl(token, DEFAULT_TEMP_LINK_MINUTES); }
    public Map<String, Object> createTemporarySetUrl(String token, int expiresInMinutes) throws IOException { return postRequest("/bot/temp_link/" + encode(token), object("expires_in_minutes", expiresInMinutes)); }
    public Map<String, Object> createTemporarySetUrlByKey(String key) throws IOException { return createTemporarySetUrlByKey(key, null, DEFAULT_TEMP_LINK_MINUTES); }
    public Map<String, Object> createTemporarySetUrlByKey(String key, String botName) throws IOException { return createTemporarySetUrlByKey(key, botName, DEFAULT_TEMP_LINK_MINUTES); }
    public Map<String, Object> createTemporarySetUrlByKey(String key, String botName, int expiresInMinutes) throws IOException {
        Map<String, Object> item = findValue(key, botName);
        return item == null ? valueNotFound() : createTemporarySetUrl(string(item.get("token")), expiresInMinutes);
    }

    public List<Map<String, Object>> getMappers() throws IOException { return listRequest("/bot/mappers"); }
    public Map<String, Object> findMapper(String key) throws IOException {
        for (Map<String, Object> mapper : getMappers()) if (java.util.Objects.equals(key, mapper.get("key"))) return mapper;
        return null;
    }
    public Map<String, Object> createMapper(Map<String, Object> config) throws IOException { return postRequest("/bot/mappers", config); }
    public Map<String, Object> updateMapper(String token, Map<String, Object> config) throws IOException { return postRequest("/bot/mappers/" + encode(token), config); }
    public Map<String, Object> deleteMapper(String token) throws IOException { return deleteRequest("/bot/mappers/" + encode(token)); }
    public String getMapperUrl(String token) throws IOException { return getMapperUrl(token, false, false); }
    public String getMapperUrl(String token, boolean merge) throws IOException { return getMapperUrl(token, merge, false); }
    public String getMapperUrl(String token, boolean merge, boolean meta) throws IOException {
        return buildUrl("/m/" + encode(token) + (merge ? "?merge=true" : "") + (meta ? (merge ? "&" : "?") + "meta=true" : ""));
    }
    public Map<String, Object> mapRequest(String token, Map<String, Object> input) throws IOException { return mapRequest(token, input, false, false); }
    public Map<String, Object> mapRequest(String token, Map<String, Object> input, boolean merge) throws IOException { return mapRequest(token, input, merge, false); }
    public Map<String, Object> mapRequest(String token, Map<String, Object> input, boolean merge, boolean meta) throws IOException {
        return request(getMapperUrl(token, merge, meta), "POST", input == null ? object() : input, false, null).result();
    }
    public Map<String, Object> map(String token, Map<String, Object> input) throws IOException { return map(token, input, false, false); }
    public Map<String, Object> map(String token, Map<String, Object> input, boolean merge) throws IOException { return map(token, input, merge, false); }
    public Map<String, Object> map(String token, Map<String, Object> input, boolean merge, boolean meta) throws IOException {
        return requireObject(request(getMapperUrl(token, merge, meta), "POST", input == null ? object() : input, false, null).requireSuccess());
    }
    public Map<String, Object> applyMap(String token, Map<String, Object> input) throws IOException { return map(token, input, true, false); }
    public Map<String, Object> mapByKey(String key, Map<String, Object> input) throws IOException { return mapByKey(key, input, false, false); }
    public Map<String, Object> mapByKey(String key, Map<String, Object> input, boolean merge) throws IOException { return mapByKey(key, input, merge, false); }
    public Map<String, Object> mapByKey(String key, Map<String, Object> input, boolean merge, boolean meta) throws IOException {
        Map<String, Object> mapper = findMapper(key);
        if (mapper == null) throw new ApiException(404, object("error", "Condition mapper not found."));
        return map(string(mapper.get("token")), input, merge, meta);
    }
    public Map<String, Object> applyMapByKey(String key, Map<String, Object> input) throws IOException { return mapByKey(key, input, true, false); }
    public List<Map<String, Object>> getBots() throws IOException { return listRequest("/bots"); }

    /** A bot-scoped handle, equivalent to new BotControl(botName) in JavaScript. */
    public Bot bot(String botName) { return new Bot(botName); }
    public final class Bot {
        private final String name;
        private Bot(String name) {
            if (name == null || name.trim().isEmpty()) throw new IllegalArgumentException("botName is required");
            this.name = name;
        }
        public Map<String, Object> getStatus() throws IOException { return getRequest("/bot/" + encode(name)); }
        public Map<String, Object> setStatus(boolean status) throws IOException { return setStatus(status, null); }
        public Map<String, Object> setStatus(boolean status, Map<String, Object> extra) throws IOException {
            Map<String, Object> body = extra == null ? object() : new LinkedHashMap<String, Object>(extra);
            body.put("status", status);
            return postRequest("/bot/" + encode(name), body);
        }
        public Map<String, Object> enable() throws IOException { return setStatus(true); }
        public Map<String, Object> disable() throws IOException { return setStatus(false); }
        public Map<String, Object> remove() throws IOException { return deleteRequest("/bot/" + encode(name)); }
        public Map<String, Object> generateUrl(String key) throws IOException { return generateUrl(key, "", ""); }
        public Map<String, Object> generateUrl(String key, String description) throws IOException { return generateUrl(key, description, ""); }
        public Map<String, Object> generateUrl(String key, String description, Object value) throws IOException {
            Map<String, Object> result = postRequest("/bot/generate_link", object("bot_name", name, "key", key, "description", description, "value", value));
            if (!Boolean.TRUE.equals(result.get("ok"))) return result;
            Object url = result.get("url");
            URL base = new URL((url == null || string(url).isEmpty() ? baseUrl : string(url)).replaceAll("/+$", "") + "/");
            result.put("permanent_access_token", result.get("access_token") == null ? result.get("token") : result.get("access_token"));
            result.put("set_value_url", resolve(base, result.get("set_value_path")));
            result.put("get_value_url", resolve(base, result.get("get_value_path")));
            result.put("user_url", resolve(base, result.get("user_path")));
            return result;
        }
        public Map<String, Object> generateTemporaryUrl(String key) throws IOException { return generateTemporaryUrl(key, "", "", DEFAULT_TEMP_LINK_MINUTES); }
        public Map<String, Object> generateTemporaryUrl(String key, String description) throws IOException { return generateTemporaryUrl(key, description, ""); }
        public Map<String, Object> generateTemporaryUrl(String key, String description, Object value) throws IOException { return generateTemporaryUrl(key, description, value, DEFAULT_TEMP_LINK_MINUTES); }
        public Map<String, Object> generateTemporaryUrl(String key, String description, Object value, int expiresInMinutes) throws IOException {
            Map<String, Object> generated = generateUrl(key, description, value);
            if (!Boolean.TRUE.equals(generated.get("ok")) || generated.get("token") == null) return generated;
            Map<String, Object> temporary = createTemporarySetUrl(string(generated.get("token")), expiresInMinutes);
            generated.putAll(object("temporary_url", temporary.get("url"), "temporary_code", temporary.get("code"),
                "temporary_expires_at", temporary.get("expires_at"), "temporary_http_code", temporary.get("http_code"), "temporary_ok", temporary.get("ok")));
            return generated;
        }
        public Map<String, Object> generateTempUrl(String key) throws IOException { return generateTemporaryUrl(key); }
        public Map<String, Object> generateTempUrl(String key, String description) throws IOException { return generateTemporaryUrl(key, description); }
        public Map<String, Object> generateTempUrl(String key, String description, Object value) throws IOException { return generateTemporaryUrl(key, description, value); }
        public Map<String, Object> generateTempUrl(String key, String description, Object value, int expiresInMinutes) throws IOException { return generateTemporaryUrl(key, description, value, expiresInMinutes); }
    }

    public String buildUrl(String path) { return path.startsWith("http://") || path.startsWith("https://") ? path : baseUrl + "/" + path.replaceAll("^/+", ""); }
    public Map<String, Object> getRequest(String path) throws IOException { return request(path, "GET", null, true, null).result(); }
    public Map<String, Object> postRequest(String path, Object body) throws IOException { return request(path, "POST", body == null ? object() : body, true, null).result(); }
    public Map<String, Object> deleteRequest(String path) throws IOException { return request(path, "DELETE", null, true, null).result(); }

    private static boolean belongsToBot(Map<String, Object> item, String name) { return java.util.Objects.equals(name, item.get("botName")) || java.util.Objects.equals(name, item.get("bot_name")); }
    private static String encode(String value) throws IOException {
        if (value == null) throw new IllegalArgumentException("path value is required");
        return URLEncoder.encode(value, "UTF-8").replace("+", "%20");
    }
    private static String resolve(URL base, Object path) throws IOException { return path == null || string(path).isEmpty() ? null : new URL(base, string(path)).toString(); }
    private static Map<String, Object> object(Object... entries) {
        Map<String, Object> result = new LinkedHashMap<String, Object>();
        for (int i = 0; i < entries.length; i += 2) result.put((String) entries[i], entries[i + 1]);
        return result;
    }
    private static Map<String, Object> valueNotFound() { return object("error", "Value control not found.", "http_code", 404, "ok", false); }
    @SuppressWarnings("unchecked")
    private static Map<String, Object> requireObject(Object value) throws IOException {
        if (!(value instanceof Map)) throw new IOException("Response was not a JSON object");
        return (Map<String, Object>) value;
    }
    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> listRequest(String path) throws IOException {
        Object data = request(path, "GET", null, true, null).requireSuccess();
        return data instanceof List ? (List<Map<String, Object>>) data : new ArrayList<Map<String, Object>>();
    }

    public static final class ApiException extends IOException {
        private static final long serialVersionUID = 1L;
        public final int httpCode;
        public final transient Object data;
        ApiException(int status, Object data) {
            super("Simple Toggle request failed (" + status + "): " + data);
            this.httpCode = status;
            this.data = data;
        }
    }
    private static final class HttpResponse {
        final int status;
        final Object data;
        final String etag;
        HttpResponse(int status, Object data, String etag) { this.status = status; this.data = data; this.etag = etag; }
        boolean ok() { return status >= 200 && status < 300; }
        Object requireSuccess() throws IOException { if (!ok()) throw new ApiException(status, data); return data; }
        @SuppressWarnings("unchecked")
        Map<String, Object> result() {
            Map<String, Object> result = data instanceof Map ? new LinkedHashMap<String, Object>((Map<String, Object>) data) : object("data", data);
            result.put("http_code", status);
            result.put("ok", ok());
            return result;
        }
    }
    private HttpResponse request(String path, String method, Object payload, boolean useAdminToken, String etag) throws IOException {
        if (useAdminToken && !hasAdminToken()) throw new IllegalStateException("Simple Toggle admin token is required for this operation.");
        HttpURLConnection connection = (HttpURLConnection) new URL(buildUrl(path)).openConnection();
        try {
            connection.setRequestMethod(method);
            connection.setConnectTimeout(connectTimeoutMs);
            connection.setReadTimeout(readTimeoutMs);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("User-Agent", "simple-toggle-java8/1.3");
            if (useAdminToken) connection.setRequestProperty("Authorization", "Bearer " + apiToken);
            if (etag != null) connection.setRequestProperty("If-None-Match", etag);
            if (payload != null) {
                byte[] bytes = Json.stringify(payload).getBytes(StandardCharsets.UTF_8);
                connection.setRequestProperty("Content-Type", "application/json");
                connection.setDoOutput(true);
                connection.setFixedLengthStreamingMode(bytes.length);
                try (java.io.OutputStream out = connection.getOutputStream()) { out.write(bytes); }
            }
            int status = connection.getResponseCode();
            String responseEtag = connection.getHeaderField("ETag");
            if (status == HttpURLConnection.HTTP_NOT_MODIFIED) return new HttpResponse(status, null, responseEtag);
            String body = readUtf8(status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream());
            Object data = null;
            if (!body.isEmpty()) {
                try { data = Json.parse(body); } catch (IOException invalidJson) { data = body; }
            }
            return new HttpResponse(status, data, responseEtag);
        } finally { connection.disconnect(); }
    }

    private MapperDefinition fetch(String url, MapperDefinition cached, boolean useAdminToken) throws IOException {
        HttpResponse response = request(url, "GET", null, useAdminToken, cached == null ? null : cached.etag);
        if (response.status == HttpURLConnection.HTTP_NOT_MODIFIED && cached != null) return cached;
        return new MapperDefinition(requireObject(response.requireSuccess()), response.etag);
    }

    private static String readUtf8(InputStream input) throws IOException {
        if (input == null) return "";
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
            StringBuilder out = new StringBuilder();
            char[] buffer = new char[4096];
            int count;
            while ((count = reader.read(buffer)) != -1) out.append(buffer, 0, count);
            return out.toString();
        }
    }

    public static final class MapperDefinition {
        private final Map<String, Object> definition;
        private final String etag;

        @SuppressWarnings("unchecked")
        public MapperDefinition(Map<String, Object> definition, String etag) {
            if (definition == null) throw new IllegalArgumentException("definition is required");
            this.definition = (Map<String, Object>) deepCopy(definition);
            this.etag = etag;
        }

        public String getKey() { return string(definition.get("key")); }
        public String getTitle() { return string(definition.get("title")); }
        public String getDescription() { return string(definition.get("description")); }
        public String getToken() { return string(definition.get("token")); }
        public String getRevision() { return string(definition.get("revision")); }
        public String getEtag() { return etag; }

        @SuppressWarnings("unchecked")
        public Map<String, Object> getExample() {
            Object value = definition.get("example");
            return value instanceof Map ? (Map<String, Object>) deepCopy(value) : new LinkedHashMap<String, Object>();
        }

        @SuppressWarnings("unchecked")
        public List<Map<String, Object>> getRules() {
            List<Map<String, Object>> result = new ArrayList<Map<String, Object>>();
            Object value = definition.get("rules");
            if (!(value instanceof List)) return result;
            for (Object rule : (List<Object>) value) if (rule instanceof Map) result.add((Map<String, Object>) deepCopy(rule));
            return result;
        }

        /** Returns a transformed deep copy; input is not modified. */
        @SuppressWarnings("unchecked")
        public Map<String, Object> evaluate(Map<String, Object> input) {
            Map<String, Object> copy = input == null ? new LinkedHashMap<String, Object>() : (Map<String, Object>) deepCopy(input);
            apply(copy);
            return copy;
        }

        /** Mutates and returns the supplied map. No network request is made. */
        public Map<String, Object> apply(Map<String, Object> target) {
            if (target == null) throw new IllegalArgumentException("target is required");
            evaluateDetailedInto(target);
            return target;
        }

        /** Same local execution, with matched rule/change metadata for debugging. */
        @SuppressWarnings("unchecked")
        public EvaluationResult evaluateDetailed(Map<String, Object> input) {
            Map<String, Object> copy = input == null ? new LinkedHashMap<String, Object>() : (Map<String, Object>) deepCopy(input);
            return evaluateDetailedInto(copy);
        }

        @SuppressWarnings("unchecked")
        private EvaluationResult evaluateDetailedInto(Map<String, Object> working) {
            Map<String, Object> changes = new LinkedHashMap<String, Object>();
            List<String> unsetFields = new ArrayList<String>();
            List<MatchedRule> matched = new ArrayList<MatchedRule>();
            Object rulesObject = definition.get("rules");
            if (!(rulesObject instanceof List)) return new EvaluationResult(working, changes, unsetFields, matched);

            List<Object> rules = (List<Object>) rulesObject;
            for (int i = 0; i < rules.size(); i++) {
                if (!(rules.get(i) instanceof Map)) continue;
                Map<String, Object> rule = (Map<String, Object>) rules.get(i);
                if (Boolean.FALSE.equals(rule.get("enabled"))) continue;
                Object when = rule.containsKey("when") ? rule.get("when") : rule.get("conditions");
                if (!condition(when, working)) continue;

                String name = string(rule.get("name"));
                String afterMatch = string(rule.containsKey("afterMatch") ? rule.get("afterMatch") : rule.get("after_match"));
                if (afterMatch.isEmpty()) afterMatch = booleanValue(rule.get("continue")) ? "continue" : "stop";
                matched.add(new MatchedRule(i, name, afterMatch));

                Object actionsObject = rule.get("actions");
                if (actionsObject instanceof List) {
                    for (Object action : (List<Object>) actionsObject) if (action instanceof Map) applyAction((Map<String, Object>) action, working, changes, unsetFields);
                } else {
                    Object resultObject = rule.containsKey("result") ? rule.get("result") : rule.get("output");
                    if (resultObject instanceof Map) {
                        for (Map.Entry<String, Object> entry : ((Map<String, Object>) resultObject).entrySet()) {
                            Object copied = deepCopy(entry.getValue());
                            setPath(working, entry.getKey(), copied);
                            setPath(changes, entry.getKey(), deepCopy(copied));
                        }
                    }
                }
                if (!"continue".equalsIgnoreCase(afterMatch)) break;
            }
            return new EvaluationResult(working, changes, unsetFields, matched);
        }
    }

    public static final class EvaluationResult {
        public final Map<String, Object> output;
        public final Map<String, Object> changes;
        public final List<String> unsetFields;
        public final List<MatchedRule> matchedRules;

        EvaluationResult(Map<String, Object> output, Map<String, Object> changes, List<String> unsetFields, List<MatchedRule> matchedRules) {
            this.output = output;
            this.changes = changes;
            this.unsetFields = unsetFields;
            this.matchedRules = matchedRules;
        }
        public boolean matched() { return !matchedRules.isEmpty(); }
    }

    public static final class MatchedRule {
        public final int index;
        public final String name;
        public final String afterMatch;
        MatchedRule(int index, String name, String afterMatch) {
            this.index = index;
            this.name = name;
            this.afterMatch = afterMatch;
        }
    }

    @SuppressWarnings("unchecked")
    private static void applyAction(Map<String, Object> action, Map<String, Object> working, Map<String, Object> changes, List<String> unsetFields) {
        String type = string(action.get("type"));
        String field = string(action.get("field"));
        if (field.isEmpty()) throw new IllegalArgumentException("Mapper action is missing field");
        if ("unset".equals(type)) {
            unsetPath(working, field);
            unsetPath(changes, field);
            unsetFields.add(field);
            return;
        }
        Object value = expression(action.get("value"), working);
        setPath(working, field, deepCopy(value));
        setPath(changes, field, deepCopy(value));
    }

    @SuppressWarnings("unchecked")
    private static Object expression(Object expression, Map<String, Object> input) {
        if (!(expression instanceof Map)) return deepCopy(expression);
        Map<String, Object> expr = (Map<String, Object>) expression;
        String type = string(expr.get("type"));
        if (type.isEmpty() && expr.containsKey("field")) return deepCopy(getPath(input, string(expr.get("field"))));
        if ("const".equals(type) || type.isEmpty()) return deepCopy(expr.get("value"));
        if ("field".equals(type)) return deepCopy(getPath(input, string(expr.containsKey("path") ? expr.get("path") : expr.get("field"))));
        if ("conditional".equals(type)) return expression(condition(expr.get("when"), input) ? expr.get("then") : expr.get("else"), input);
        if (!"op".equals(type)) throw new IllegalArgumentException("Unsupported expression type: " + type);

        String op = string(expr.get("op"));
        List<Object> values = new ArrayList<Object>();
        Object argsObject = expr.get("args");
        if (argsObject instanceof List) for (Object arg : (List<Object>) argsObject) values.add(expression(arg, input));
        if (values.isEmpty()) throw new IllegalArgumentException(op + " expression has no arguments");

        if ("concat".equals(op)) {
            StringBuilder out = new StringBuilder();
            for (Object value : values) if (value != null) out.append(String.valueOf(value));
            return out.toString();
        }
        if ("coalesce".equals(op)) {
            for (Object value : values) if (value != null) return value;
            return null;
        }

        BigDecimal result;
        if ("add".equals(op)) {
            result = BigDecimal.ZERO;
            for (Object value : values) result = result.add(number(value));
        } else if ("multiply".equals(op)) {
            result = BigDecimal.ONE;
            for (Object value : values) result = result.multiply(number(value));
        } else if ("subtract".equals(op)) {
            result = number(values.get(0));
            for (int i = 1; i < values.size(); i++) result = result.subtract(number(values.get(i)));
        } else if ("divide".equals(op)) {
            result = number(values.get(0));
            for (int i = 1; i < values.size(); i++) {
                BigDecimal divisor = number(values.get(i));
                if (divisor.compareTo(BigDecimal.ZERO) == 0) throw new ArithmeticException("Division by zero");
                result = result.divide(divisor, MathContext.DECIMAL64);
            }
        } else throw new IllegalArgumentException("Unsupported expression operator: " + op);
        return niceNumber(result);
    }

    @SuppressWarnings("unchecked")
    private static boolean condition(Object nodeObject, Map<String, Object> input) {
        if (!(nodeObject instanceof Map)) return true;
        Map<String, Object> node = (Map<String, Object>) nodeObject;
        if (node.get("and") instanceof List || node.get("or") instanceof List) {
            boolean or = !(node.get("and") instanceof List);
            for (Object child : (List<Object>) node.get(or ? "or" : "and")) {
                if (condition(child, input) == or) return or;
            }
            return !or;
        }
        String type = string(node.get("type"));
        if ("group".equals(type) || node.get("children") instanceof List) {
            String op = string(node.get("op"));
            List<Object> children = node.get("children") instanceof List ? (List<Object>) node.get("children") : new ArrayList<Object>();
            if ("or".equalsIgnoreCase(op)) {
                for (Object child : children) if (condition(child, input)) return true;
                return false;
            }
            for (Object child : children) if (!condition(child, input)) return false;
            return true;
        }

        String field = string(node.get("field"));
        String operator = string(node.get("operator"));
        if (operator.isEmpty()) operator = "eq";
        Object actual = getPath(input, field);
        Object expected = node.get("value");
        if ("eq".equals(operator) || "=".equals(operator) || "==".equals(operator)) return equal(actual, expected);
        if ("neq".equals(operator) || "!=".equals(operator)) return !equal(actual, expected);
        if ("gt".equals(operator) || ">".equals(operator)) return compare(actual, expected) > 0;
        if ("gte".equals(operator) || ">=".equals(operator)) return compare(actual, expected) >= 0;
        if ("lt".equals(operator) || "<".equals(operator)) return compare(actual, expected) < 0;
        if ("lte".equals(operator) || "<=".equals(operator)) return compare(actual, expected) <= 0;
        if ("contains".equals(operator)) {
            if (actual instanceof Collection) {
                for (Object item : (Collection<Object>) actual) if (equal(item, expected)) return true;
                return false;
            }
            return string(actual).contains(string(expected));
        }
        if ("starts_with".equals(operator) || "startsWith".equals(operator)) return (actual == null ? "" : String.valueOf(actual)).startsWith(expected == null ? "" : String.valueOf(expected));
        if ("ends_with".equals(operator) || "endsWith".equals(operator)) return (actual == null ? "" : String.valueOf(actual)).endsWith(expected == null ? "" : String.valueOf(expected));
        if ("in".equals(operator) || "not_in".equals(operator)) {
            boolean found = false;
            if (expected instanceof Collection) {
                for (Object candidate : (Collection<Object>) expected) if (equal(actual, candidate)) { found = true; break; }
            } else {
                String[] items = String.valueOf(expected == null ? "" : expected).split(",");
                for (String candidate : items) if (equal(actual, candidate.trim())) { found = true; break; }
            }
            return "in".equals(operator) ? found : !found;
        }
        if ("exists".equals(operator)) return actual != null;
        if ("empty".equals(operator)) return empty(actual);
        if ("not_empty".equals(operator)) return !empty(actual);
        throw new IllegalArgumentException("Unsupported condition operator: " + operator);
    }

    private static boolean equal(Object actual, Object expected) {
        if (expected == null) return actual == null;
        if (expected instanceof Number) {
            try { return number(actual).compareTo(number(expected)) == 0; } catch (RuntimeException ignored) { return false; }
        }
        if (expected instanceof Boolean) return booleanValue(actual) == ((Boolean) expected).booleanValue();
        if (expected instanceof Map || expected instanceof List) return expected.equals(actual);
        return String.valueOf(actual == null ? "" : actual).equals(String.valueOf(expected));
    }

    private static int compare(Object a, Object b) {
        try { return number(a).compareTo(number(b)); }
        catch (RuntimeException ignored) { return String.valueOf(a == null ? "" : a).compareTo(String.valueOf(b == null ? "" : b)); }
    }

    private static boolean empty(Object value) {
        if (value == null) return true;
        if (value instanceof String) return ((String) value).isEmpty();
        if (value instanceof Collection) return ((Collection<?>) value).isEmpty();
        if (value instanceof Map) return ((Map<?, ?>) value).isEmpty();
        return false;
    }

    private static boolean booleanValue(Object value) {
        if (value instanceof Boolean) return ((Boolean) value).booleanValue();
        if (value instanceof Number) return ((Number) value).doubleValue() != 0d;
        if (value == null) return false;
        String text = String.valueOf(value).trim().toLowerCase();
        if ("true".equals(text) || "1".equals(text) || "yes".equals(text) || "y".equals(text)) return true;
        if ("false".equals(text) || "0".equals(text) || "no".equals(text) || "n".equals(text) || text.isEmpty()) return false;
        return true;
    }

    private static BigDecimal number(Object value) {
        if (value == null || "".equals(value)) throw new NumberFormatException("null/empty is not numeric");
        if (value instanceof BigDecimal) return (BigDecimal) value;
        return new BigDecimal(String.valueOf(value));
    }

    private static Object niceNumber(BigDecimal value) {
        BigDecimal stripped = value.stripTrailingZeros();
        if (stripped.scale() <= 0) {
            try { return Long.valueOf(stripped.longValueExact()); } catch (ArithmeticException ignored) { }
        }
        return Double.valueOf(value.doubleValue());
    }

    @SuppressWarnings("unchecked")
    private static Object getPath(Object root, String path) {
        if (root == null || path == null || path.isEmpty()) return root;
        if (root instanceof Map && ((Map<String, Object>) root).containsKey(path)) return ((Map<String, Object>) root).get(path);
        Object current = root;
        for (String part : path.split("\\.")) {
            if (current instanceof Map) current = ((Map<String, Object>) current).get(part);
            else if (current instanceof List && part.matches("\\d+")) {
                int index = Integer.parseInt(part);
                List<Object> list = (List<Object>) current;
                current = index >= 0 && index < list.size() ? list.get(index) : null;
            } else return null;
        }
        return current;
    }

    @SuppressWarnings("unchecked")
    private static void setPath(Object root, String path, Object value) {
        String[] parts = path.split("\\.");
        Object current = root;
        for (int i = 0; i < parts.length - 1; i++) {
            String part = parts[i];
            String next = parts[i + 1];
            if (current instanceof Map) {
                Map<String, Object> map = (Map<String, Object>) current;
                Object child = map.get(part);
                if (!(child instanceof Map) && !(child instanceof List)) {
                    child = next.matches("\\d+") ? new ArrayList<Object>() : new LinkedHashMap<String, Object>();
                    map.put(part, child);
                }
                current = child;
            } else if (current instanceof List && part.matches("\\d+")) {
                List<Object> list = (List<Object>) current;
                int index = Integer.parseInt(part);
                while (list.size() <= index) list.add(null);
                Object child = list.get(index);
                if (!(child instanceof Map) && !(child instanceof List)) {
                    child = next.matches("\\d+") ? new ArrayList<Object>() : new LinkedHashMap<String, Object>();
                    list.set(index, child);
                }
                current = child;
            } else throw new IllegalArgumentException("Cannot set path: " + path);
        }
        String last = parts[parts.length - 1];
        if (current instanceof Map) ((Map<String, Object>) current).put(last, value);
        else if (current instanceof List && last.matches("\\d+")) {
            List<Object> list = (List<Object>) current;
            int index = Integer.parseInt(last);
            while (list.size() <= index) list.add(null);
            list.set(index, value);
        } else throw new IllegalArgumentException("Cannot set path: " + path);
    }

    @SuppressWarnings("unchecked")
    private static void unsetPath(Object root, String path) {
        int dot = path.lastIndexOf('.');
        Object parent = dot < 0 ? root : getPath(root, path.substring(0, dot));
        String last = dot < 0 ? path : path.substring(dot + 1);
        if (parent instanceof Map) ((Map<String, Object>) parent).remove(last);
        else if (parent instanceof List && last.matches("\\d+")) {
            int index = Integer.parseInt(last);
            List<Object> list = (List<Object>) parent;
            if (index >= 0 && index < list.size()) list.remove(index);
        }
    }

    @SuppressWarnings("unchecked")
    private static Object deepCopy(Object value) {
        if (value instanceof Map) {
            Map<String, Object> copy = new LinkedHashMap<String, Object>();
            for (Map.Entry<String, Object> entry : ((Map<String, Object>) value).entrySet()) copy.put(entry.getKey(), deepCopy(entry.getValue()));
            return copy;
        }
        if (value instanceof List) {
            List<Object> copy = new ArrayList<Object>();
            for (Object item : (List<Object>) value) copy.add(deepCopy(item));
            return copy;
        }
        return value;
    }

    private static String string(Object value) { return value == null ? "" : String.valueOf(value); }

    public static final class Json {
        public static Object parse(String json) throws IOException { return new Parser(json).parse(); }

        public static String stringify(Object value) {
            StringBuilder out = new StringBuilder();
            write(value, out);
            return out.toString();
        }
        private static void write(Object value, StringBuilder out) {
            if (value == null) { out.append("null"); return; }
            if (value instanceof Boolean) { out.append(value); return; }
            if (value instanceof Number) {
                if (!Double.isFinite(((Number) value).doubleValue())) throw new IllegalArgumentException("JSON numbers must be finite");
                out.append(new BigDecimal(value.toString()).stripTrailingZeros().toPlainString());
                return;
            }
            if (value instanceof String || value instanceof Character) {
                out.append('"');
                for (char c : value.toString().toCharArray()) {
                    if (c == '"' || c == '\\') out.append('\\').append(c);
                    else if (c < 0x20 || Character.isSurrogate(c)) {
                        String hex = Integer.toHexString(c);
                        out.append("\\u");
                        for (int i = hex.length(); i < 4; i++) out.append('0');
                        out.append(hex);
                    } else out.append(c);
                }
                out.append('"');
                return;
            }
            if (value instanceof Map) {
                out.append('{');
                boolean first = true;
                for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) {
                    if (!(entry.getKey() instanceof String)) throw new IllegalArgumentException("JSON object keys must be strings");
                    if (!first) out.append(',');
                    first = false;
                    write(entry.getKey(), out); out.append(':'); write(entry.getValue(), out);
                }
                out.append('}');
                return;
            }
            if (value instanceof Iterable || value.getClass().isArray()) {
                out.append('[');
                if (value instanceof Iterable) {
                    boolean first = true;
                    for (Object item : (Iterable<?>) value) { if (!first) out.append(','); first = false; write(item, out); }
                } else {
                    for (int i = 0; i < java.lang.reflect.Array.getLength(value); i++) {
                        if (i > 0) out.append(',');
                        write(java.lang.reflect.Array.get(value, i), out);
                    }
                }
                out.append(']');
                return;
            }
            throw new IllegalArgumentException("Unsupported JSON value: " + value.getClass().getName());
        }

        private static final class Parser {
            private final String s;
            private int i;
            Parser(String s) { this.s = s == null ? "" : s; }

            Object parse() throws IOException {
                skip();
                Object value = value();
                skip();
                if (i != s.length()) error("Trailing data");
                return value;
            }

            private Object value() throws IOException {
                skip();
                if (i >= s.length()) error("Unexpected end of JSON");
                char c = s.charAt(i);
                if (c == '{') return object();
                if (c == '[') return array();
                if (c == '"') return string();
                if (c == 't' && literal("true")) return Boolean.TRUE;
                if (c == 'f' && literal("false")) return Boolean.FALSE;
                if (c == 'n' && literal("null")) return null;
                if (c == '-' || (c >= '0' && c <= '9')) return number();
                error("Unexpected character: " + c);
                return null;
            }

            private Map<String, Object> object() throws IOException {
                LinkedHashMap<String, Object> map = new LinkedHashMap<String, Object>();
                i++; skip();
                if (peek('}')) { i++; return map; }
                while (true) {
                    skip();
                    if (!peek('"')) error("Object key must be a string");
                    String key = string();
                    skip(); expect(':');
                    map.put(key, value());
                    skip();
                    if (peek('}')) { i++; return map; }
                    expect(',');
                }
            }

            private List<Object> array() throws IOException {
                ArrayList<Object> list = new ArrayList<Object>();
                i++; skip();
                if (peek(']')) { i++; return list; }
                while (true) {
                    list.add(value());
                    skip();
                    if (peek(']')) { i++; return list; }
                    expect(',');
                }
            }

            private String string() throws IOException {
                expect('"');
                StringBuilder out = new StringBuilder();
                while (i < s.length()) {
                    char c = s.charAt(i++);
                    if (c == '"') return out.toString();
                    if (c != '\\') { out.append(c); continue; }
                    if (i >= s.length()) error("Bad escape");
                    char e = s.charAt(i++);
                    if (e == '"' || e == '\\' || e == '/') out.append(e);
                    else if (e == 'b') out.append('\b');
                    else if (e == 'f') out.append('\f');
                    else if (e == 'n') out.append('\n');
                    else if (e == 'r') out.append('\r');
                    else if (e == 't') out.append('\t');
                    else if (e == 'u') {
                        if (i + 4 > s.length()) error("Bad unicode escape");
                        try { out.append((char) Integer.parseInt(s.substring(i, i + 4), 16)); }
                        catch (NumberFormatException ex) { error("Bad unicode escape"); }
                        i += 4;
                    } else error("Bad escape: " + e);
                }
                error("Unterminated string");
                return null;
            }

            private Number number() throws IOException {
                int start = i;
                if (peek('-')) i++;
                while (i < s.length() && Character.isDigit(s.charAt(i))) i++;
                boolean decimal = false;
                if (peek('.')) { decimal = true; i++; while (i < s.length() && Character.isDigit(s.charAt(i))) i++; }
                if (i < s.length() && (s.charAt(i) == 'e' || s.charAt(i) == 'E')) {
                    decimal = true; i++;
                    if (peek('-') || peek('+')) i++;
                    while (i < s.length() && Character.isDigit(s.charAt(i))) i++;
                }
                String text = s.substring(start, i);
                try { if (decimal) return Double.valueOf(text); return Long.valueOf(text); }
                catch (NumberFormatException ex) { error("Bad number: " + text); return null; }
            }

            private boolean literal(String text) {
                if (!s.regionMatches(i, text, 0, text.length())) return false;
                i += text.length(); return true;
            }
            private void expect(char c) throws IOException { skip(); if (!peek(c)) error("Expected '" + c + "'"); i++; }
            private boolean peek(char c) { return i < s.length() && s.charAt(i) == c; }
            private void skip() { while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++; }
            private void error(String message) throws IOException { throw new IOException(message + " at character " + i); }
        }
    }
}
