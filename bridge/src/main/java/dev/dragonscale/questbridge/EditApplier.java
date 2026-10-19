package dev.dragonscale.questbridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.ftb.mods.ftbquests.net.EditObjectResponseMessage;
import dev.ftb.mods.ftbquests.quest.Quest;
import dev.ftb.mods.ftbquests.quest.QuestObjectBase;
import dev.ftb.mods.ftbquests.quest.ServerQuestFile;
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
import net.neoforged.neoforge.network.PacketDistributor;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Applies edits to the live quest book.
 *
 * <p>Field edits are a read-modify-write through FTB's own serialization: ask the
 * object to write itself to NBT, patch that NBT, and hand it back with
 * {@code readData}. Nothing here knows what a field means, so every task type,
 * reward type and addon-injected key is editable without a line of code per type —
 * the same principle that makes {@code /book} and {@code /types} work.
 *
 * <p>Titles and descriptions are not in that NBT. FTB routes them through its
 * translation manager into the lang file, so they have their own setters.
 */
public final class EditApplier {
    /** Thrown for a bad request; the message is safe to return to the client. */
    public static final class BadEdit extends RuntimeException {
        BadEdit(String msg) { super(msg); }
    }

    private EditApplier() {}

    public record Result(long version, int applied, List<String> touched) {}

    public static Result apply(ServerQuestFile file, JsonArray edits) {
        Set<QuestObjectBase> changed = new LinkedHashSet<>();
        int applied = 0;

        for (JsonElement e : edits) {
            if (!e.isJsonObject()) throw new BadEdit("each edit must be an object");
            JsonObject edit = e.getAsJsonObject();
            String op = str(edit, "op");

            switch (op) {
                case "set" -> { changed.add(set(file, edit)); applied++; }
                case "setText" -> { changed.add(setText(file, edit)); applied++; }
                default -> throw new BadEdit("unsupported op: " + op
                    + " (this build supports set and setText)");
            }
        }

        // One save and one broadcast for the whole batch, not per edit.
        file.markDirty();
        file.clearCachedData();
        if (!changed.isEmpty()) {
            PacketDistributor.sendToAllPlayers(new EditObjectResponseMessage(new ArrayList<>(changed)));
        }

        // Lambda, not a method reference: getCodeString is overloaded with two
        // static forms and the reference is ambiguous.
        List<String> touched = changed.stream().map(o -> o.getCodeString()).toList();
        return new Result(BookVersion.bump(), applied, touched);
    }

    // ------------------------------------------------------------------ ops --

    private static QuestObjectBase set(ServerQuestFile file, JsonObject edit) {
        QuestObjectBase obj = target(file, str(edit, "target"));
        String path = str(edit, "path");
        if (!path.startsWith("data.")) {
            throw new BadEdit("set path must start with 'data.' (got " + path + ")");
        }

        CompoundTag tag = new CompoundTag();
        obj.writeData(tag, file.holderLookup());
        patch(tag, path.substring("data.".length()).split("\\."), edit.get("value"));
        obj.readData(tag, file.holderLookup());
        return obj;
    }

    private static QuestObjectBase setText(ServerQuestFile file, JsonObject edit) {
        QuestObjectBase obj = target(file, str(edit, "target"));
        String key = str(edit, "key");
        JsonElement value = edit.get("value");

        switch (key) {
            case "title" -> obj.setRawTitle(value.getAsString());
            case "subtitle" -> {
                if (!(obj instanceof Quest q)) throw new BadEdit("only a quest has a subtitle");
                q.setRawSubtitle(value.getAsString());
            }
            case "description" -> {
                if (!(obj instanceof Quest q)) throw new BadEdit("only a quest has a description");
                List<String> lines = new ArrayList<>();
                if (value.isJsonArray()) for (JsonElement l : value.getAsJsonArray()) lines.add(l.getAsString());
                else lines.add(value.getAsString());
                q.setRawDescription(lines);
            }
            default -> throw new BadEdit("unknown text key: " + key);
        }
        return obj;
    }

    // ------------------------------------------------------------- plumbing --

    /** "quest:345900C71CE2A226" or a bare id. */
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
     * Writes a value at a dotted path, keeping the existing NBT type where there is
     * one. Preserving the type matters: writing a double where FTB expects a long
     * makes the file unreadable on the next load.
     */
    private static void patch(CompoundTag root, String[] path, JsonElement value) {
        CompoundTag parent = root;
        for (int i = 0; i < path.length - 1; i++) {
            Tag next = parent.get(path[i]);
            CompoundTag child;
            if (next instanceof CompoundTag existing) {
                child = existing;
            } else {
                child = new CompoundTag();
                parent.put(path[i], child);
            }
            parent = child;
        }
        String leaf = path[path.length - 1];
        if (value == null || value.isJsonNull()) {
            parent.remove(leaf);
            return;
        }
        parent.put(leaf, toNbt(value, parent.get(leaf)));
    }

    private static Tag toNbt(JsonElement v, Tag existing) {
        if (v.isJsonObject()) {
            CompoundTag c = new CompoundTag();
            for (var en : v.getAsJsonObject().entrySet()) {
                if (en.getKey().equals("$types")) continue;
                c.put(en.getKey(), toNbt(en.getValue(), null));
            }
            return c;
        }
        if (v.isJsonArray()) {
            ListTag l = new ListTag();
            for (JsonElement el : v.getAsJsonArray()) l.add(toNbt(el, null));
            return l;
        }
        var prim = v.getAsJsonPrimitive();
        if (prim.isBoolean()) return ByteTag.valueOf(prim.getAsBoolean());
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

    private static String str(JsonObject o, String key) {
        JsonElement v = o.get(key);
        if (v == null || !v.isJsonPrimitive()) throw new BadEdit("missing field: " + key);
        return v.getAsString();
    }
}
