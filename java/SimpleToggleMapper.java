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
 * Dependency-free Java 8 client + local evaluator for Simple Toggle condition mappers.
 *
 * Typical usage:
 *
 *   SimpleToggleMapper simpleToggle = new SimpleToggleMapper("https://toggle.example.com");
 *   SimpleToggleMapper.MapperDefinition mapper = simpleToggle.getMapper("kish-orders-coupons");
 *
 *   // Fetch happens once. Reuse this object for every row.
 *   Map<String, Object> output = mapper.evaluate(order); // transformed copy
 *   mapper.apply(order);                                // or mutate the original map
 *
 * getMapper(key) is cached in memory. Call refreshMapper(key) when you want a conditional
 * HTTP revalidation; Simple Toggle supplies ETag/Last-Modified headers and returns 304 when unchanged.
 */
public class SimpleToggleMapper {
    private final String baseUrl;
    private final Map<String, MapperDefinition> cache = new LinkedHashMap<String, MapperDefinition>();
    private int connectTimeoutMs = 10000;
    private int readTimeoutMs = 30000;

    public SimpleToggleMapper(String baseUrl) {
        if (baseUrl == null || baseUrl.trim().isEmpty()) throw new IllegalArgumentException("baseUrl is required");
        this.baseUrl = baseUrl.replaceAll("/+$", "");
    }

    public SimpleToggleMapper setTimeouts(int connectTimeoutMs, int readTimeoutMs) {
        this.connectTimeoutMs = connectTimeoutMs;
        this.readTimeoutMs = readTimeoutMs;
        return this;
    }

    /** Returns the cached mapper, fetching it only when absent. */
    public synchronized MapperDefinition getMapper(String key) throws IOException {
        MapperDefinition cached = cache.get(key);
        if (cached != null) return cached;
        return refreshMapper(key);
    }

    /**
     * Revalidates the mapper over HTTP. If the server returns 304, the same cached instance is returned.
     * Use this on your own schedule (for example once per batch, every few minutes, etc.).
     */
    public synchronized MapperDefinition refreshMapper(String key) throws IOException {
        if (key == null || key.trim().isEmpty()) throw new IllegalArgumentException("key is required");
        MapperDefinition cached = cache.get(key);
        String encoded = URLEncoder.encode(key, "UTF-8").replace("+", "%20");
        MapperDefinition fresh = fetch(baseUrl + "/m/key/" + encoded, cached);
        if (fresh != null) cache.put(key, fresh);
        return fresh != null ? fresh : cached;
    }

    /** Fetches a mapper by permanent mapper token. This does not share the key cache. */
    public MapperDefinition getMapperByToken(String token) throws IOException {
        if (token == null || token.trim().isEmpty()) throw new IllegalArgumentException("token is required");
        String encoded = URLEncoder.encode(token, "UTF-8").replace("+", "%20");
        return fetch(baseUrl + "/m/" + encoded, null);
    }

    public synchronized void invalidate(String key) { cache.remove(key); }
    public synchronized void clearCache() { cache.clear(); }

    private MapperDefinition fetch(String url, MapperDefinition cached) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setRequestMethod("GET");
        connection.setConnectTimeout(connectTimeoutMs);
        connection.setReadTimeout(readTimeoutMs);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("User-Agent", "simple-toggle-java8/1.0");
        if (cached != null && cached.etag != null) connection.setRequestProperty("If-None-Match", cached.etag);

        int status = connection.getResponseCode();
        if (status == HttpURLConnection.HTTP_NOT_MODIFIED) return null;
        InputStream stream = status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream();
        String body = readUtf8(stream);
        if (status < 200 || status >= 300) throw new IOException("Simple Toggle mapper request failed (" + status + "): " + body);

        Object parsed = Json.parse(body);
        if (!(parsed instanceof Map)) throw new IOException("Mapper response was not a JSON object");
        @SuppressWarnings("unchecked") Map<String, Object> definition = (Map<String, Object>) parsed;
        return new MapperDefinition(definition, connection.getHeaderField("ETag"));
    }

    private static String readUtf8(InputStream input) throws IOException {
        if (input == null) return "";
        BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8));
        StringBuilder out = new StringBuilder();
        String line;
        while ((line = reader.readLine()) != null) out.append(line).append('\n');
        return out.toString();
    }

    public static final class MapperDefinition {
        private final Map<String, Object> definition;
        private final String etag;

        MapperDefinition(Map<String, Object> definition, String etag) {
            this.definition = definition;
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
                Object when = rule.get("when");
                if (!condition(when, working)) continue;

                String name = string(rule.get("name"));
                String afterMatch = string(rule.get("afterMatch"));
                if (afterMatch.isEmpty()) afterMatch = booleanValue(rule.get("continue")) ? "continue" : "stop";
                matched.add(new MatchedRule(i, name, afterMatch));

                Object actionsObject = rule.get("actions");
                if (actionsObject instanceof List) {
                    for (Object action : (List<Object>) actionsObject) if (action instanceof Map) applyAction((Map<String, Object>) action, working, changes, unsetFields);
                } else {
                    // Backward compatibility with old {result:{...}} mapper rules.
                    Object resultObject = rule.get("result");
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
        Object actual = getPath(input, field);
        Object expected = node.get("value");
        if ("eq".equals(operator) || "=".equals(operator) || "==".equals(operator)) return equal(actual, expected);
        if ("neq".equals(operator) || "!=".equals(operator)) return !equal(actual, expected);
        if ("gt".equals(operator) || ">".equals(operator)) return compare(actual, expected) > 0;
        if ("gte".equals(operator) || ">=".equals(operator)) return compare(actual, expected) >= 0;
        if ("lt".equals(operator) || "<".equals(operator)) return compare(actual, expected) < 0;
        if ("lte".equals(operator) || "<=".equals(operator)) return compare(actual, expected) <= 0;
        if ("contains".equals(operator)) {
            if (actual instanceof Collection) for (Object item : (Collection<Object>) actual) if (equal(item, expected)) return true;
            return actual != null && String.valueOf(actual).contains(expected == null ? "" : String.valueOf(expected));
        }
        if ("starts_with".equals(operator)) return (actual == null ? "" : String.valueOf(actual)).startsWith(expected == null ? "" : String.valueOf(expected));
        if ("ends_with".equals(operator)) return (actual == null ? "" : String.valueOf(actual)).endsWith(expected == null ? "" : String.valueOf(expected));
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

    /** Tiny JSON parser so this file has zero third-party dependencies on Java 8. */
    private static final class Json {
        static Object parse(String json) throws IOException { return new Parser(json).parse(); }

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
                    if (i < s.length() && (s.charAt(i) == '+' || s.charAt(i) == '-')) i++;
                    while (i < s.length() && Character.isDigit(s.charAt(i))) i++;
                }
                String text = s.substring(start, i);
                try { return decimal ? Double.valueOf(text) : Long.valueOf(text); }
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
