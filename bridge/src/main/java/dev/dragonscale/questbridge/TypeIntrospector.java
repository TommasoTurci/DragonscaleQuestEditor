package dev.dragonscale.questbridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.ftb.mods.ftbquests.quest.Chapter;
import dev.ftb.mods.ftbquests.quest.Quest;
import dev.ftb.mods.ftbquests.quest.ServerQuestFile;
import dev.ftb.mods.ftbquests.quest.reward.Reward;
import dev.ftb.mods.ftbquests.quest.reward.RewardType;
import dev.ftb.mods.ftbquests.quest.reward.RewardTypes;
import dev.ftb.mods.ftbquests.quest.task.Task;
import dev.ftb.mods.ftbquests.quest.task.TaskType;
import dev.ftb.mods.ftbquests.quest.task.TaskTypes;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.resources.ResourceLocation;

import java.util.Map;

/**
 * Reports every task and reward type the server has registered, with the fields
 * each one writes — discovered by asking the type to build a default instance and
 * serialize it, not by anyone transcribing 48 {@code writeData} methods by hand.
 *
 * <p>This is what makes "support every quest type" cheap. Install an addon and its
 * types appear in the editor with no change to this mod or to the web app. Nothing
 * here knows what an item task or a kill task is.
 *
 * <p>A field missing from a default instance is one FTB omits at its default value,
 * which is most of them — see {@code docs/format.md}. The editor must treat an
 * absent key as a default rather than as null, and must not write a value back that
 * equals the default.
 */
public final class TypeIntrospector {
    private TypeIntrospector() {}

    public static JsonObject types(ServerQuestFile file) {
        JsonObject out = new JsonObject();
        out.add("tasks", tasks(file));
        out.add("rewards", rewards(file));
        return out;
    }

    /**
     * Both registries need a parent quest to construct against. We borrow a real one
     * and never attach what we build — the objects are created, serialized and
     * dropped, so the book is untouched.
     */
    private static Quest scratchQuest(ServerQuestFile file) {
        for (Chapter c : file.getAllChapters()) {
            if (!c.getQuests().isEmpty()) return c.getQuests().get(0);
        }
        return null;
    }

    private static JsonObject tasks(ServerQuestFile file) {
        JsonObject out = new JsonObject();
        Quest parent = scratchQuest(file);
        for (Map.Entry<ResourceLocation, TaskType> e : TaskTypes.TYPES.entrySet()) {
            TaskType type = e.getValue();
            JsonObject entry = baseEntry(e.getKey(), type.getTypeForNBT(), displayName(type));
            if (parent != null) {
                try {
                    Task probe = type.createTask(0L, parent);
                    entry.add("fields", fieldsOf(file, probe));
                } catch (Exception ex) {
                    // A type that refuses to construct without real context is still
                    // worth listing; the editor falls back to a generic field form.
                    entry.addProperty("introspectionFailed", ex.getClass().getSimpleName());
                }
            }
            out.add(e.getKey().toString(), entry);
        }
        return out;
    }

    private static JsonObject rewards(ServerQuestFile file) {
        JsonObject out = new JsonObject();
        Quest parent = scratchQuest(file);
        for (Map.Entry<ResourceLocation, RewardType> e : RewardTypes.TYPES.entrySet()) {
            RewardType type = e.getValue();
            JsonObject entry = baseEntry(e.getKey(), type.getTypeForNBT(), displayName(type));
            if (parent != null) {
                try {
                    Reward probe = type.createReward(0L, parent);
                    entry.add("fields", fieldsOf(file, probe));
                } catch (Exception ex) {
                    entry.addProperty("introspectionFailed", ex.getClass().getSimpleName());
                }
            }
            out.add(e.getKey().toString(), entry);
        }
        return out;
    }

    private static JsonObject baseEntry(ResourceLocation id, String nbtType, String label) {
        JsonObject entry = new JsonObject();
        entry.addProperty("id", id.toString());
        entry.addProperty("nbtType", nbtType);
        entry.addProperty("namespace", id.getNamespace());
        if (label != null && !label.isEmpty()) entry.addProperty("label", label);
        return entry;
    }

    /** Serialize a default instance and report what it wrote. */
    private static JsonObject fieldsOf(ServerQuestFile file, Object probe) {
        CompoundTag tag = new CompoundTag();
        if (probe instanceof Task t) t.writeData(tag, file.holderLookup());
        else if (probe instanceof Reward r) r.writeData(tag, file.holderLookup());

        JsonObject fields = new JsonObject();
        JsonObject json = NbtJson.toJson(tag);
        JsonObject declared = json.has("$types") ? json.getAsJsonObject("$types") : new JsonObject();
        for (String key : json.keySet()) {
            if (key.equals("$types") || key.equals("type")) continue;
            JsonObject f = new JsonObject();
            f.addProperty("type", declared.has(key)
                ? declared.get(key).getAsString()
                : inferred(json.get(key)));
            f.add("default", json.get(key));
            fields.add(key, f);
        }
        return fields;
    }

    private static String inferred(com.google.gson.JsonElement v) {
        if (v.isJsonObject()) return "compound";
        if (v.isJsonArray()) return "list";
        if (v.isJsonPrimitive() && v.getAsJsonPrimitive().isBoolean()) return "boolean";
        if (v.isJsonPrimitive() && v.getAsJsonPrimitive().isNumber()) return "number";
        return "string";
    }

    private static String displayName(Object type) {
        try {
            if (type instanceof TaskType t) return t.getDisplayName().getString();
            if (type instanceof RewardType r) return r.getDisplayName().getString();
        } catch (Exception ignored) {
            // Display names resolve against the language file, which a dedicated
            // server has no reason to have loaded. The id is enough.
        }
        return "";
    }

    /** Convenience for logging what the server actually has registered. */
    public static JsonArray summary() {
        JsonArray arr = new JsonArray();
        arr.add(TaskTypes.TYPES.size());
        arr.add(RewardTypes.TYPES.size());
        return arr;
    }
}
