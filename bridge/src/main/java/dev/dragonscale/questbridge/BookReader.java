package dev.dragonscale.questbridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.ftb.mods.ftbquests.quest.Chapter;
import dev.ftb.mods.ftbquests.quest.ChapterGroup;
import dev.ftb.mods.ftbquests.quest.Quest;
import dev.ftb.mods.ftbquests.quest.QuestObjectBase;
import dev.ftb.mods.ftbquests.quest.ServerQuestFile;
import net.minecraft.nbt.CompoundTag;

import java.util.Optional;

/**
 * Reads the live quest book into JSON.
 *
 * <p>Every object serializes itself through FTB's own {@code writeData}, so this
 * class contains no knowledge of task types, reward types or addon fields — and
 * therefore cannot fall out of date with them.
 *
 * <p>Titles and descriptions are not in that output. FTB routes them through its
 * translation manager into {@code lang/en_us.snbt}, so they are fetched separately
 * through {@code getTitle()} and attached under {@code text}.
 */
public final class BookReader {
    private BookReader() {}

    public static Optional<ServerQuestFile> file() {
        return ServerQuestFile.getInstance();
    }

    public static JsonObject book(ServerQuestFile f) {
        JsonObject out = new JsonObject();
        out.addProperty("version", BookVersion.current());

        JsonArray groups = new JsonArray();
        for (ChapterGroup g : f.getChapterGroups()) {
            JsonObject jg = new JsonObject();
            jg.addProperty("id", g.getCodeString());
            jg.addProperty("title", plainTitle(g));
            JsonArray chapters = new JsonArray();
            for (Chapter c : g.getChapters()) chapters.add(chapter(f, c));
            jg.add("chapters", chapters);
            groups.add(jg);
        }
        out.add("chapterGroups", groups);
        return out;
    }

    private static JsonObject chapter(ServerQuestFile f, Chapter c) {
        JsonObject out = new JsonObject();
        // No getFilename() accessor — it is private. It is written into the
        // serialized data as "filename", so nothing is lost.
        out.addProperty("id", c.getCodeString());
        out.add("text", text(c));
        out.add("data", data(f, c));

        JsonArray quests = new JsonArray();
        for (Quest q : c.getQuests()) {
            JsonObject jq = new JsonObject();
            jq.addProperty("id", q.getCodeString());
            jq.add("text", text(q));
            jq.add("data", data(f, q));
            quests.add(jq);
        }
        out.add("quests", quests);
        return out;
    }

    /** Serialize through FTB so addon fields survive without us knowing about them. */
    private static JsonObject data(ServerQuestFile f, QuestObjectBase obj) {
        CompoundTag tag = new CompoundTag();
        obj.writeData(tag, f.holderLookup());
        return NbtJson.toJson(tag);
    }

    private static JsonObject text(QuestObjectBase obj) {
        JsonObject t = new JsonObject();
        String title = plainTitle(obj);
        if (!title.isEmpty()) t.addProperty("title", title);
        return t;
    }

    private static String plainTitle(QuestObjectBase obj) {
        try {
            return obj.getTitle().getString();
        } catch (Exception e) {
            return "";
        }
    }
}
