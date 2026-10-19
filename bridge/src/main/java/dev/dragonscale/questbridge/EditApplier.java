package dev.dragonscale.questbridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mojang.datafixers.util.Either;
import dev.ftb.mods.ftbquests.quest.Chapter;
import dev.ftb.mods.ftbquests.quest.Quest;
import dev.ftb.mods.ftbquests.quest.QuestObjectBase;
import dev.ftb.mods.ftbquests.quest.QuestObjectType;
import dev.ftb.mods.ftbquests.quest.ServerQuestFile;
import dev.ftb.mods.ftbquests.quest.history.CreateOrDeleteRecord;
import dev.ftb.mods.ftbquests.quest.history.EditRecord;
import dev.ftb.mods.ftbquests.quest.history.events.CreateQuestObjects;
import dev.ftb.mods.ftbquests.quest.history.events.DeleteQuestObjects;
import dev.ftb.mods.ftbquests.quest.history.events.ModifyQuestObjects;
import dev.ftb.mods.ftbquests.quest.history.events.UpdateTranslation;
import dev.ftb.mods.ftbquests.quest.reward.RewardType;
import dev.ftb.mods.ftbquests.quest.task.TaskType;
import dev.ftb.mods.ftbquests.quest.translation.TranslationKey;
import net.minecraft.nbt.ByteTag;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.DoubleTag;
import net.minecraft.nbt.FloatTag;
import net.minecraft.nbt.IntTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.nbt.LongTag;
import net.minecraft.nbt.ShortTag;
import net.minecraft.nbt.StringTag;
import net.minecraft.nbt.Tag;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Applies edits to the live quest book.
 *
 * <p>Nothing here knows what a field means. A field edit is a read-modify-write
 * through FTB's own serialization — ask the object to write itself to NBT, patch
 * that NBT, hand it back — so every task type, reward type and addon-injected key
 * is editable without a line of code per type. That is the same principle that
 * makes {@code /book} and {@code /types} work.
 *
 * <p><b>Edits go through FTB's own history events</b> rather than being applied by
 * hand. {@link ModifyQuestObjects}, {@link CreateQuestObjects},
 * {@link DeleteQuestObjects} and {@link UpdateTranslation} are the events the
 * in-game editor raises, and routing through {@code HistoryStack.addAndApply} buys
 * four things that are tedious and easy to get subtly wrong otherwise:
 *
 * <ul>
 * <li>the right broadcast, to the players who have the book open in edit mode
 *     rather than to everyone;
 * <li>{@code editedFromGUIOnServer()} and the cache invalidation each type expects
 *     after a change;
 * <li>text written through the translation manager <em>and</em> synced to clients.
 *     Calling {@code setRawTitle} on the server updates the lang table but tells
 *     nobody, so a rename would not appear in game until a reconnect;
 * <li>undo. An edit made from the web app lands on the same stack as an edit made
 *     in game, so it can be undone from the quest book like any other.
 * </ul>
 */
public final class EditApplier {
    /** Thrown for a bad request; the message is safe to return to the client. */
    public static final class BadEdit extends RuntimeException {
        BadEdit(String msg) { super(msg); }
    }

    private EditApplier() {}

    public record Result(long version, int applied, List<String> touched, List<String> created) {}

    public static Result apply(ServerQuestFile file, JsonArray edits) {
        Session s = new Session(file);
        for (JsonElement e : edits) {
            if (!e.isJsonObject()) throw new BadEdit("each edit must be an object");
            s.op(e.getAsJsonObject());
        }
        s.flush();
        return s.result();
    }

    // --------------------------------------------------------------- session --

    /**
     * One request. Field edits accumulate per object and are flushed as a single
     * history event, so dragging a quest and resizing it in the same batch is one
     * undo step and one broadcast rather than several.
     */
    private static final class Session {
        private final ServerQuestFile file;
        private final Map<Long, CompoundTag> pending = new LinkedHashMap<>();
        private final Set<String> touched = new LinkedHashSet<>();
        private final List<String> created = new ArrayList<>();
        private int applied = 0;

        Session(ServerQuestFile file) { this.file = file; }

        void op(JsonObject edit) {
            switch (str(edit, "op")) {
                case "set" -> set(edit);
                case "setText" -> setText(edit);
                case "create" -> create(edit);
                case "delete" -> delete(edit);
                default -> throw new BadEdit("unsupported op: " + str(edit, "op")
                    + " (expected set, setText, create or delete)");
            }
            applied++;
        }

        // --- field edits ---

        private void set(JsonObject edit) {
            QuestObjectBase obj = target(file, str(edit, "target"));
            CompoundTag tag = pending.computeIfAbsent(obj.getId(), k -> snapshot(obj));

            if (edit.has("fields")) {
                JsonObject fields = edit.getAsJsonObject("fields");
                for (String path : fields.keySet()) patch(tag, path, fields.get(path), null);
            } else {
                patch(tag, path(edit), edit.get("value"),
                    edit.has("type") ? str(edit, "type") : null);
            }
            touched.add(obj.getCodeString());
        }

        /** Dotted path under {@code data.}, which is how {@code /book} reports it. */
        private static String path(JsonObject edit) {
            String p = str(edit, "path");
            if (!p.startsWith("data.")) {
                throw new BadEdit("set path must start with 'data.' (got " + p + ")");
            }
            return p.substring("data.".length());
        }

        private CompoundTag snapshot(QuestObjectBase obj) {
            CompoundTag tag = new CompoundTag();
            obj.writeData(tag, file.holderLookup());
            return tag;
        }

        void flush() {
            if (pending.isEmpty()) return;
            List<EditRecord> records = new ArrayList<>();
            for (var e : pending.entrySet()) {
                QuestObjectBase obj = file.getBase(e.getKey());
                if (obj == null) continue;          // deleted later in the same batch
                records.add(new EditRecord(obj.getId(), obj.getObjectType(), obj.getTitle(), e.getValue()));
            }
            pending.clear();
            // Empty when every value already equalled what was there, which is a
            // no-op rather than an error: a drag that ends where it started.
            ModifyQuestObjects.fromEditRecords(file, records)
                .ifPresent(ev -> file.getHistoryStack().addAndApply(file, ev));
        }

        // --- text ---

        /**
         * Titles, subtitles and descriptions are not in the object's NBT at all; FTB
         * keeps them in the translation table, keyed by object id.
         */
        private void setText(JsonObject edit) {
            QuestObjectBase obj = target(file, str(edit, "target"));
            String key = str(edit, "key");
            TranslationKey tk = switch (key) {
                case "title" -> TranslationKey.TITLE;
                case "subtitle" -> {
                    if (obj instanceof Chapter) yield TranslationKey.CHAPTER_SUBTITLE;
                    if (obj instanceof Quest) yield TranslationKey.QUEST_SUBTITLE;
                    // A task has a title and nothing else. Writing a quest_subtitle
                    // key against its id would put a line in the lang file that
                    // nothing ever reads.
                    throw new BadEdit("only a quest or a chapter has a subtitle");
                }
                case "description" -> TranslationKey.QUEST_DESC;
                default -> throw new BadEdit("unknown text key: " + key
                    + " (expected title, subtitle or description)");
            };
            if (tk == TranslationKey.QUEST_DESC && !(obj instanceof Quest)) {
                throw new BadEdit("only a quest has a description");
            }

            JsonElement value = edit.get("value");
            Either<String, List<String>> val = tk.isListVal()
                ? Either.right(stringList(value))
                : Either.left(value == null || value.isJsonNull() ? "" : value.getAsString());

            UpdateTranslation.create(file, obj, file.getLocale(), tk, tk.validate(val))
                .ifPresent(ev -> file.getHistoryStack().addAndApply(file, ev));
            touched.add(obj.getCodeString());
        }

        private static List<String> stringList(JsonElement value) {
            List<String> lines = new ArrayList<>();
            if (value == null || value.isJsonNull()) return lines;
            if (value.isJsonArray()) {
                for (JsonElement l : value.getAsJsonArray()) lines.add(l.getAsString());
            } else {
                // A multi-line string from a textarea is the natural thing for a
                // client to send, and splitting it here beats making every caller
                // remember to.
                for (String line : value.getAsString().split("\n", -1)) lines.add(line);
            }
            return lines;
        }

        // --- create ---

        /**
         * Built the way the in-game editor builds one: construct a detached object
         * with id 0, describe it as a creation record, and let FTB's own event
         * allocate the id, attach it to its parent and tell everyone.
         */
        private void create(JsonObject edit) {
            flush();                        // the new object must not race pending edits
            String kind = str(edit, "kind");
            QuestObjectBase detached = switch (kind) {
                case "quest" -> new Quest(0L, chapter(str(edit, "parent")));
                case "task" -> TaskType.requireCreateTask(0L, quest(str(edit, "parent")), typeOf(edit));
                case "reward" -> RewardType.requireCreateReward(0L, quest(str(edit, "parent")), typeOf(edit));
                default -> throw new BadEdit("cannot create a " + kind
                    + " (this build creates quests, tasks and rewards)");
            };

            CreateOrDeleteRecord rec = CreateOrDeleteRecord.ofQuestObject(detached);
            CompoundTag tag = rec.nbt().copy();
            if (edit.has("data")) {
                JsonObject data = edit.getAsJsonObject("data");
                for (String p : data.keySet()) patch(tag, p, data.get(p), null);
            }

            long id = file.newID();
            file.getHistoryStack().addAndApply(file, new CreateQuestObjects(
                new CreateOrDeleteRecord(id, rec.parent(), rec.questObjectType(),
                    rec.title(), tag, rec.extra()), null));

            QuestObjectBase made = file.getBase(id);
            if (made == null) throw new BadEdit("the server refused to create the " + kind);
            created.add(made.getCodeString());
            touched.add(made.getCodeString());

            // Naming it is part of creating it, as far as a user is concerned.
            if (edit.has("text")) {
                JsonObject text = edit.getAsJsonObject("text");
                for (String key : text.keySet()) {
                    JsonObject one = new JsonObject();
                    one.addProperty("target", made.getCodeString());
                    one.addProperty("key", key);
                    one.add("value", text.get(key));
                    setText(one);
                }
            }
        }

        private static String typeOf(JsonObject edit) {
            // An empty type means the default, which FTB resolves to an item task.
            return edit.has("type") ? str(edit, "type") : "";
        }

        private Chapter chapter(String id) {
            if (target(file, id) instanceof Chapter c) return c;
            throw new BadEdit("not a chapter: " + id);
        }

        private Quest quest(String id) {
            if (target(file, id) instanceof Quest q) return q;
            throw new BadEdit("not a quest: " + id);
        }

        // --- delete ---

        private void delete(JsonObject edit) {
            flush();
            QuestObjectBase obj = target(file, str(edit, "target"));
            QuestObjectType type = obj.getObjectType();
            // The book itself and a chapter group are not things a click should be
            // able to remove: deleting a group takes every chapter in it along.
            if (type == QuestObjectType.FILE || type == QuestObjectType.CHAPTER_GROUP) {
                throw new BadEdit("refusing to delete a " + type.getId() + " from the editor");
            }
            String code = obj.getCodeString();
            file.getHistoryStack().addAndApply(file,
                new DeleteQuestObjects(CreateOrDeleteRecord.fromIds(file, List.of(obj.getId()))));
            touched.add(code);
        }

        Result result() {
            file.markDirty();
            file.clearCachedData();
            return new Result(BookVersion.bump(), applied, List.copyOf(touched), created);
        }
    }

    // -------------------------------------------------------------- plumbing --

    /** "quest:345900C71CE2A226" or a bare "345900C71CE2A226". */
    private static QuestObjectBase target(ServerQuestFile file, String target) {
        String hex = target.contains(":") ? target.substring(target.indexOf(':') + 1) : target;
        long id;
        try {
            id = Long.parseUnsignedLong(hex, 16);
        } catch (NumberFormatException e) {
            throw new BadEdit("not an object id: " + target);
        }
        QuestObjectBase obj = file.getBase(id);
        if (obj == null) throw new BadEdit("no such object: " + target);
        return obj;
    }

    /**
     * Writes a value at a dotted path. The NBT type is taken from an explicit hint,
     * else from whatever is already there, else guessed — in that order, because
     * writing a double where FTB expects a long makes the file unreadable on the
     * next load, and a field absent from the data is one FTB omitted at its default,
     * so there is nothing there to learn the type from.
     */
    private static void patch(CompoundTag root, String dotted, JsonElement value, String hint) {
        String[] path = dotted.split("\\.");
        CompoundTag parent = root;
        for (int i = 0; i < path.length - 1; i++) {
            Tag next = parent.get(path[i]);
            if (next instanceof CompoundTag existing) {
                parent = existing;
            } else {
                CompoundTag child = new CompoundTag();
                parent.put(path[i], child);
                parent = child;
            }
        }
        String leaf = path[path.length - 1];
        if (value == null || value.isJsonNull()) {
            parent.remove(leaf);
            return;
        }
        parent.put(leaf, toNbt(value, parent.get(leaf), hint));
    }

    private static Tag toNbt(JsonElement v, Tag existing, String hint) {
        if (v.isJsonObject()) {
            CompoundTag c = new CompoundTag();
            for (var en : v.getAsJsonObject().entrySet()) {
                if (en.getKey().equals("$types")) continue;     // our own annotation
                c.put(en.getKey(), toNbt(en.getValue(), null, null));
            }
            return c;
        }
        if (v.isJsonArray()) {
            ListTag l = new ListTag();
            for (JsonElement el : v.getAsJsonArray()) l.add(toNbt(el, null, hint));
            return l;
        }
        var prim = v.getAsJsonPrimitive();
        // A numeric hint wins over JSON's own typing, because a form field is a
        // string even when the field it edits is a number.
        if (hint != null && !"string".equals(hint) && !prim.isBoolean()) {
            Tag coerced = numeric(hint, prim.getAsString());
            if (coerced != null) return coerced;
        }
        if (prim.isBoolean()) {
            return "string".equals(hint)
                ? StringTag.valueOf(prim.getAsString())
                : ByteTag.valueOf(prim.getAsBoolean());
        }
        if (prim.isString()) return StringTag.valueOf(prim.getAsString());

        // Match whatever is already there, so a long stays a long.
        if (existing instanceof IntTag) return IntTag.valueOf(prim.getAsInt());
        if (existing instanceof LongTag) return LongTag.valueOf(prim.getAsLong());
        if (existing instanceof ShortTag) return ShortTag.valueOf(prim.getAsShort());
        if (existing instanceof ByteTag) return ByteTag.valueOf(prim.getAsByte());
        if (existing instanceof FloatTag) return FloatTag.valueOf(prim.getAsFloat());
        if (existing instanceof DoubleTag) return DoubleTag.valueOf(prim.getAsDouble());

        double d = prim.getAsDouble();
        return d == Math.rint(d) && Math.abs(d) < Integer.MAX_VALUE
            ? IntTag.valueOf((int) d)
            : DoubleTag.valueOf(d);
    }

    /** Null when the hint is not a numeric NBT type. */
    private static Tag numeric(String hint, String text) {
        try {
            return switch (hint) {
                case "byte" -> ByteTag.valueOf((byte) Double.parseDouble(text));
                case "short" -> ShortTag.valueOf((short) Double.parseDouble(text));
                case "int" -> IntTag.valueOf((int) Double.parseDouble(text));
                case "long" -> LongTag.valueOf((long) Double.parseDouble(text));
                case "float" -> FloatTag.valueOf(Float.parseFloat(text));
                case "double" -> DoubleTag.valueOf(Double.parseDouble(text));
                case "boolean" -> ByteTag.valueOf("true".equalsIgnoreCase(text) || "1".equals(text));
                default -> null;
            };
        } catch (NumberFormatException e) {
            throw new BadEdit("not a " + hint + ": " + text);
        }
    }

    private static String str(JsonObject o, String key) {
        JsonElement v = o.get(key);
        if (v == null || !v.isJsonPrimitive()) throw new BadEdit("missing field: " + key);
        return v.getAsString();
    }
}
