package dev.dragonscale.questbridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import net.minecraft.nbt.ByteArrayTag;
import net.minecraft.nbt.ByteTag;
import net.minecraft.nbt.CollectionTag;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.DoubleTag;
import net.minecraft.nbt.FloatTag;
import net.minecraft.nbt.IntArrayTag;
import net.minecraft.nbt.IntTag;
import net.minecraft.nbt.LongArrayTag;
import net.minecraft.nbt.LongTag;
import net.minecraft.nbt.NumericTag;
import net.minecraft.nbt.ShortTag;
import net.minecraft.nbt.StringTag;
import net.minecraft.nbt.Tag;

/**
 * Converts NBT to JSON without knowing anything about quests.
 *
 * <p>This is what lets the bridge support every task and reward type, including
 * ones from addons it has never heard of: a quest object serializes itself through
 * FTB's own {@code writeData}, and we hand the result over verbatim.
 *
 * <p>NBT distinguishes byte/short/int/long/float/double where JSON has one number
 * type. For reading that difference does not matter. It will matter when edits come
 * back the other way, so the type of each leaf is recorded alongside the value under
 * {@code $types} rather than being lost.
 */
public final class NbtJson {
    private NbtJson() {}

    public static JsonObject toJson(CompoundTag tag) {
        JsonObject out = new JsonObject();
        JsonObject types = new JsonObject();
        for (String key : tag.getAllKeys()) {
            Tag v = tag.get(key);
            out.add(key, convert(v));
            String t = typeOf(v);
            if (t != null) types.addProperty(key, t);
        }
        if (!types.isEmpty()) out.add("$types", types);
        return out;
    }

    private static JsonElement convert(Tag v) {
        if (v == null) return JsonNull.INSTANCE;
        if (v instanceof CompoundTag c) return toJson(c);
        if (v instanceof StringTag s) return new JsonPrimitive(s.getAsString());
        if (v instanceof ByteTag b) {
            // NBT has no boolean; FTB writes flags as bytes, and 0/1 are almost
            // always booleans in this data. Keep the byte type in $types so an
            // edit can be written back as the right thing.
            byte raw = b.getAsByte();
            return (raw == 0 || raw == 1) ? new JsonPrimitive(raw == 1) : new JsonPrimitive(raw);
        }
        if (v instanceof NumericTag n) return new JsonPrimitive(numberOf(n));
        if (v instanceof CollectionTag<?> list) {
            JsonArray arr = new JsonArray();
            for (Tag e : list) arr.add(convert(e));
            return arr;
        }
        return new JsonPrimitive(v.getAsString());
    }

    private static Number numberOf(NumericTag n) {
        if (n instanceof IntTag i) return i.getAsInt();
        if (n instanceof LongTag l) return l.getAsLong();
        if (n instanceof ShortTag s) return s.getAsShort();
        if (n instanceof FloatTag f) return f.getAsFloat();
        if (n instanceof DoubleTag d) return d.getAsDouble();
        return n.getAsNumber();
    }

    private static String typeOf(Tag v) {
        if (v instanceof ByteTag) return "byte";
        if (v instanceof ShortTag) return "short";
        if (v instanceof IntTag) return "int";
        if (v instanceof LongTag) return "long";
        if (v instanceof FloatTag) return "float";
        if (v instanceof DoubleTag) return "double";
        if (v instanceof ByteArrayTag) return "byte[]";
        if (v instanceof IntArrayTag) return "int[]";
        if (v instanceof LongArrayTag) return "long[]";
        return null;   // compounds, lists and strings are unambiguous in JSON
    }
}
