import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public class ClientParityTest {
    static Map<String, Object> obj(Object... entries) {
        Map<String, Object> result = new LinkedHashMap<String, Object>();
        for (int i = 0; i < entries.length; i += 2) result.put((String) entries[i], entries[i + 1]);
        return result;
    }
    static void check(boolean passed, String message) { if (!passed) throw new AssertionError(message); }
    @SuppressWarnings("unchecked")
    public static void main(String[] args) throws Exception {
        List<Map<String, Object>> fixtures = (List<Map<String, Object>>) SimpleToggleMapper.Json.parse(new String(Files.readAllBytes(Paths.get(args[1])), StandardCharsets.UTF_8));
        List<Object> results = new ArrayList<Object>();
        for (Map<String, Object> fixture : fixtures) {
            Map<String, Object> input = (Map<String, Object>) fixture.get("input");
            String before = SimpleToggleMapper.Json.stringify(input);
            SimpleToggleMapper.MapperDefinition mapper = new SimpleToggleMapper.MapperDefinition(obj("rules", fixture.get("rules")), null);
            SimpleToggleMapper.EvaluationResult evaluation = mapper.evaluateDetailed(input);
            check(before.equals(SimpleToggleMapper.Json.stringify(input)), "evaluateDetailed mutated input: " + fixture.get("name"));
            Map<String, Object> copy = mapper.evaluate(input);
            check(SimpleToggleMapper.Json.stringify(copy).equals(SimpleToggleMapper.Json.stringify(evaluation.output)), "evaluate differs from detailed");
            List<Object> matched = new ArrayList<Object>();
            for (SimpleToggleMapper.MatchedRule rule : evaluation.matchedRules) matched.add(obj("index", rule.index, "name", rule.name, "afterMatch", rule.afterMatch));
            results.add(obj("output", evaluation.output, "changes", evaluation.changes, "unsetFields", evaluation.unsetFields, "matchedRules", matched, "matched", evaluation.matched()));
            mapper.getRules().clear();
            check(mapper.apply(input) == input, "apply must preserve identity");
            check(SimpleToggleMapper.Json.stringify(input).equals(SimpleToggleMapper.Json.stringify(evaluation.output)), "apply differs from evaluate");
        }
        SimpleToggleMapper client = new SimpleToggleMapper(args[0] + "///", "admin");
        Map<String, Object> report = new LinkedHashMap<String, Object>();
        report.put("values", client.getValues());
        report.put("valuesMap", client.getValuesMap());
        report.put("byBot", client.getValuesByBot("a"));
        report.put("found", client.findValue("duplicate", "b"));
        report.put("false", client.getValueByKey("false", "fallback"));
        report.put("zero", client.getValueByKey("zero", "fallback"));
        report.put("empty", client.getValueByKey("empty", "fallback"));
        report.put("null", client.getValueByKey("null", "fallback"));
        report.put("missing", client.getValueByKey("missing", "fallback"));
        report.put("value", client.getValue("value /שלום"));
        report.put("only", client.getValueOnlyValue("value /שלום", "fallback"));
        report.put("onlyMissing", client.getValueOnlyValue("missing", "fallback"));
        report.put("nonEmpty", client.getValueOnlyValueNoEmptyOrNull("blank", "fallback"));
        report.put("set", client.setValue("value /שלום", "שלום\n\"quoted\"\\ \ud83d\ude00"));
        report.put("setKey", client.setValueByKey("duplicate", 0, "b"));
        report.put("missingSet", client.setValueByKey("missing", true));
        report.put("deleteValue", client.deleteValue("value /שלום"));
        report.put("permanent", client.getPermanentValueUrl("value /שלום", true));
        report.put("temporary", client.createTemporarySetUrl("value /שלום", 0));
        report.put("temporaryDefault", client.createTemporarySetUrl("value /שלום"));
        report.put("temporaryKey", client.createTemporarySetUrlByKey("duplicate", "b", 15));
        report.put("missingTemporary", client.createTemporarySetUrlByKey("missing"));
        report.put("mappers", client.getMappers());
        report.put("findMapper", client.findMapper("orders /שלום"));
        report.put("createMapper", client.createMapper(obj("key", "new", "rules", new ArrayList<Object>())));
        report.put("updateMapper", client.updateMapper("mapper /שלום", obj("title", "updated")));
        report.put("deleteMapper", client.deleteMapper("mapper /שלום"));
        Map<String, Object> row = obj("amount", 2);
        report.put("map", client.map("mapper /שלום", row));
        report.put("mapRequest", client.mapRequest("mapper /שלום", row));
        report.put("applyMap", client.applyMap("mapper /שלום", row));
        report.put("mapMeta", client.map("mapper /שלום", row, false, true));
        report.put("mapByKey", client.mapByKey("orders /שלום", row));
        report.put("applyByKey", client.applyMapByKey("orders /שלום", row));
        report.put("mapperUrl", client.getMapperUrl("mapper /שלום", true, true));
        report.put("bots", client.getBots());
        SimpleToggleMapper.Bot bot = client.bot("bot /שלום");
        report.put("status", bot.getStatus());
        report.put("enable", bot.enable());
        report.put("disable", bot.disable());
        report.put("setStatus", bot.setStatus(true, obj("title", "title")));
        report.put("remove", bot.remove());
        report.put("generated", bot.generateUrl("key", "description", false));
        report.put("generatedTemporary", bot.generateTemporaryUrl("key", "description", 0, 15));
        report.put("generatedAlias", bot.generateTempUrl("key"));
        SimpleToggleMapper.MapperDefinition mapper = client.getMapper("orders /שלום");
        check(mapper == client.getMapper("orders /שלום"), "getMapper cache");
        check(mapper == client.refreshMapper("orders /שלום"), "304 identity");
        report.put("local", mapper.evaluate(row));
        report.put("anonymousMapper", new SimpleToggleMapper(args[0]).getMapperByToken("mapper /שלום").evaluate(row));
        report.put("anonymousValue", new SimpleToggleMapper(args[0]).getValue("value /שלום"));
        client.invalidate("orders /שלום");
        check(mapper != client.getMapper("orders /שלום"), "invalidate");
        client.clearCache();
        check(mapper != client.getMapper("orders /שלום"), "clearCache");
        try { new SimpleToggleMapper(args[0]).getValues(); throw new AssertionError("missing admin token accepted"); }
        catch (IllegalStateException expected) { }
        try { new SimpleToggleMapper(args[0] + "/error", "admin").getValues(); throw new AssertionError("HTTP error swallowed"); }
        catch (SimpleToggleMapper.ApiException expected) { check(expected.httpCode == 503, "HTTP status lost"); }
        try { client.getMapper("missing"); throw new AssertionError("404 mapper accepted"); }
        catch (SimpleToggleMapper.ApiException expected) { check(expected.httpCode == 404, "mapper HTTP status lost"); }
        try { client.getMapperByToken("invalid"); throw new AssertionError("non-object definition accepted"); }
        catch (IOException expected) { }
        check("fallback".equals(new SimpleToggleMapper(args[0] + "/error").getValueOnlyValue("x", "fallback")), "error fallback");
        System.out.write(SimpleToggleMapper.Json.stringify(obj("fixtures", results, "http", report)).getBytes(StandardCharsets.UTF_8));
        System.out.write('\n');
    }
}
