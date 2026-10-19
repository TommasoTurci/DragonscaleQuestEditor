package dev.dragonscale.questbridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.ftb.mods.ftbquests.quest.Chapter;
import dev.ftb.mods.ftbquests.quest.ChapterGroup;
import dev.ftb.mods.ftbquests.quest.Quest;
import dev.ftb.mods.ftbquests.quest.QuestObjectBase;
import dev.ftb.mods.ftbquests.quest.ServerQuestFile;
import dev.ftb.mods.ftbquests.quest.reward.Reward;
import dev.ftb.mods.ftbquests.quest.task.Task;
import net.minecraft.nbt.CompoundTag;

import java.util.List;
import java.util.Optional;

/**
 * Reads the live quest book into JSON.
 *
 * <p>Every object serializes itself through FTB's own {@code writeData}, so this
 * class contains no knowledge of task types, reward types or addon fields — and
 * therefore cannot fall out of date with them.
 *
 * <p>Two things are not in that output and are fetched separately:
 *
 * <ul>
 * <li><b>Text.</b> Titles, subtitles and descriptions live in {@code lang/en_us.snbt}
 *     via FTB's translation manager. Both forms are reported: {@code title} as
 *     displayed, and {@code rawTitle} as stored — they differ for an untitled quest,
 *     where FTB falls back to the name of the first task's item.
 * <li><b>Tasks and rewards.</b> {@code Quest.writeData} does not write them;
 *     {@code writeTasks} and {@code writeRewards} are separate methods, and the file
 *     writer calls them itself. Each is a quest object in its own right with its own
 *     id, so each is reported the same way a quest is — which is also what makes
 *     them editable by id with no extra machinery.
 * </ul>
 */
public final class BookReader {
    private BookReader() {}

    public static Optional<ServerQuestFile> file() {
        return ServerQuestFile.getInstance();
    }

    public static JsonObject book(ServerQuestFile f) {
        JsonObject out = new JsonObject();
        out.addProperty("version", BookVersion.current());
        out.add("chapterGroups", groups(f));
        return out;
    }

    /**
     * A cheap fingerprint of the book's contents, with the version left out.
     *
     * <p>FTB raises no event when a quest is edited in game, so the only way to
     * notice one is to look. This is what {@link BookWatch} compares. The length is
     * mixed in with the hash because a 32-bit collision here means a missed update,
     * and the pair costs no more than either alone.
     */
    public static long digest(ServerQuestFile f) {
        String s = groups(f).toString();
        return ((long) s.hashCode() << 32) | (s.length() & 0xffffffffL);
    }

    private static JsonArray groups(ServerQuestFile f) {
        JsonArray groups = new JsonArray();
        for (ChapterGroup g : f.getChapterGroups()) {
            JsonObject jg = new JsonObject();
            jg.addProperty("id", g.getCodeString());
            jg.addProperty("title", display(g));
            JsonArray chapters = new JsonArray();
            for (Chapter c : g.getChapters()) chapters.add(chapter(f, c));
            jg.add("chapters", chapters);
            groups.add(jg);
        }
        return groups;
    }

    private static JsonObject chapter(ServerQuestFile f, Chapter c) {
        JsonObject out = new JsonObject();
        // No getFilename() accessor — it is private. It is written into the
        // serialized data as "filename", so nothing is lost.
        out.addProperty("id", c.getCodeString());
        out.add("text", text(c));
        out.add("data", data(f, c));

        JsonArray quests = new JsonArray();
        for (Quest q : c.getQuests()) quests.add(quest(f, q));
        out.add("quests", quests);
        return out;
    }

    private static JsonObject quest(ServerQuestFile f, Quest q) {
        JsonObject out = new JsonObject();
        out.addProperty("id", q.getCodeString());
        out.addProperty("chapter", q.getQuestChapter().getCodeString());
        out.add("text", text(q));
        out.add("data", data(f, q));

        JsonArray tasks = new JsonArray();
        for (Task t : q.getTasksAsList()) tasks.add(child(f, t, t.getType().getTypeId().toString()));
        out.add("tasks", tasks);

        JsonArray rewards = new JsonArray();
        for (Reward r : q.getRewards()) rewards.add(child(f, r, r.getType().getTypeId().toString()));
        out.add("rewards", rewards);
        return out;
    }

    /**
     * A task or a reward. {@code typeId} is the registry id ({@code ftbquests:item});
     * the short name FTB writes to NBT is in {@code data.type}, and {@code /types}
     * reports both so the editor can map between them.
     */
    private static JsonObject child(ServerQuestFile f, QuestObjectBase obj, String typeId) {
        JsonObject out = new JsonObject();
        out.addProperty("id", obj.getCodeString());
        out.addProperty("typeId", typeId);
        out.add("text", text(obj));
        out.add("data", data(f, obj));
        return out;
    }

    /** Serialize through FTB so addon fields survive without us knowing about them. */
    private static JsonObject data(ServerQuestFile f, QuestObjectBase obj) {
        CompoundTag tag = new CompoundTag();
        obj.writeData(tag, f.holderLookup());
        return NbtJson.toJson(tag);
    }

    /**
     * The editable text of an object. {@code rawTitle} is what is stored and what an
     * edit writes back; {@code title} is what FTB displays, which for an untitled
     * object is derived from its contents.
     */
    private static JsonObject text(QuestObjectBase obj) {
        JsonObject t = new JsonObject();
        String shown = display(obj);
        if (!shown.isEmpty()) t.addProperty("title", shown);
        t.addProperty("rawTitle", raw(obj::getRawTitle, ""));

        if (obj instanceof Quest q) {
            t.addProperty("subtitle", raw(q::getRawSubtitle, ""));
            t.add("description", lines(raw(q::getRawDescription, List.of())));
        } else if (obj instanceof Chapter c) {
            t.add("subtitle", lines(raw(c::getRawSubtitle, List.of())));
        }
        return t;
    }

    private static JsonArray lines(List<String> src) {
        JsonArray arr = new JsonArray();
        for (String s : src) arr.add(s);
        return arr;
    }

    /**
     * Text is resolved against the translation table, which a dedicated server has
     * no guarantee of having loaded for every object. One missing title must not
     * cost the whole book.
     */
    private static <T> T raw(java.util.function.Supplier<T> get, T fallback) {
        try {
            T v = get.get();
            return v == null ? fallback : v;
        } catch (Exception e) {
            return fallback;
        }
    }

    private static String display(QuestObjectBase obj) {
        try {
            return obj.getTitle().getString();
        } catch (Exception e) {
            return "";
        }
    }
}
