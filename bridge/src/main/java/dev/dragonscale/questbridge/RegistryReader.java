package dev.dragonscale.questbridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.ResourceKey;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.level.Level;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * Lists what the server actually has: every biome, entity type, structure,
 * advancement and so on, by registry.
 *
 * <p>This is what lets the editor offer a field's real options instead of an empty
 * text box. A biome task asking someone to type {@code minecraft:lush_caves} from
 * memory is a typo waiting to become a quest nobody can complete, and the pack has
 * hundreds of biomes that exist only because some mod added them.
 *
 * <p>Nothing here is a hard-coded list. The registries are enumerated from the
 * running server, so a mod's content appears for the same reason its task types do:
 * because it is there.
 */
public final class RegistryReader {
    /** A registry nobody wants to download, and nobody would scroll. */
    private static final int MAX = 40_000;

    /** Not registries, but the same question: a set of ids a field can hold. */
    private static final String ADVANCEMENTS = "questbridge:advancements";
    private static final String DIMENSIONS = "questbridge:dimensions";

    private RegistryReader() {}

    /** Every registry with its size, so a client can offer a sensible chooser. */
    public static JsonObject list(MinecraftServer mc) {
        JsonObject out = new JsonObject();
        JsonArray arr = new JsonArray();
        for (var e : all(mc).entrySet()) {
            JsonObject one = new JsonObject();
            one.addProperty("name", e.getKey());
            one.addProperty("size", e.getValue().size());
            one.addProperty("tags", (int) e.getValue().getTagNames().count());
            arr.add(one);
        }
        for (String special : new String[] { ADVANCEMENTS, DIMENSIONS }) {
            JsonObject one = new JsonObject();
            one.addProperty("name", special);
            one.addProperty("size", ids(mc, special).size());
            one.addProperty("tags", 0);
            arr.add(one);
        }
        out.add("registries", arr);
        return out;
    }

    /** The ids in one registry, or its tag names. */
    public static JsonObject values(MinecraftServer mc, String name, boolean tags) {
        JsonObject out = new JsonObject();
        out.addProperty("name", name);
        out.addProperty("tags", tags);

        List<String> values;
        if (tags) {
            Registry<?> r = all(mc).get(name);
            values = r == null ? List.of()
                : r.getTagNames().map(t -> t.location().toString()).sorted().toList();
        } else {
            values = ids(mc, name);
        }
        if (values.size() > MAX) values = values.subList(0, MAX);

        JsonArray arr = new JsonArray();
        for (String v : values) arr.add(v);
        out.add("values", arr);
        out.addProperty("count", arr.size());
        return out;
    }

    private static List<String> ids(MinecraftServer mc, String name) {
        if (ADVANCEMENTS.equals(name)) {
            List<String> out = new ArrayList<>();
            mc.getAdvancements().getAllAdvancements().forEach(a -> out.add(a.id().toString()));
            out.sort(null);
            return out;
        }
        if (DIMENSIONS.equals(name)) {
            List<String> out = new ArrayList<>();
            for (ResourceKey<Level> k : mc.levelKeys()) out.add(k.location().toString());
            out.sort(null);
            return out;
        }
        Registry<?> r = all(mc).get(name);
        if (r == null) return List.of();
        return r.keySet().stream().map(ResourceLocation::toString).sorted().toList();
    }

    /**
     * Static registries plus the world's dynamic ones. Dynamic wins where both
     * exist: biomes and structures come from the loaded world, not from a frozen
     * default that would not include anything a datapack added.
     */
    private static Map<String, Registry<?>> all(MinecraftServer mc) {
        Map<String, Registry<?>> out = new TreeMap<>();
        for (ResourceLocation rl : BuiltInRegistries.REGISTRY.keySet()) {
            BuiltInRegistries.REGISTRY.getOptional(rl).ifPresent(r -> out.put(rl.toString(), r));
        }
        mc.registryAccess().registries()
            .forEach(e -> out.put(e.key().location().toString(), e.value()));
        return out;
    }
}
