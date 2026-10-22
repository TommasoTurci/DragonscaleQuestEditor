package dev.dragonscale.questbridge;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * A paragraph about an item, kept with the pack.
 *
 * <p>The book is a tutorial, so the work of writing it is mostly working out what
 * each thing actually is and saying so. That knowledge arrives one item at a time,
 * from a wiki, from a mod author's own words, or from playing the pack, and it is
 * worth keeping the moment it arrives rather than retyping it into every quest
 * that needs it.
 *
 * <p>A flat file rather than a database: it is a few hundred short strings, it
 * wants to be readable and greppable, and it sits in the quest folder so the git
 * history already covers it.
 */
public final class Notes {
    private static final Gson GSON = new Gson();

    private final Path file;
    private final Map<String, String> notes = new ConcurrentHashMap<>();

    public Notes(Path configDir) {
        this.file = configDir.resolve("questbridge").resolve("notes.json");
        load();
    }

    private void load() {
        if (!Files.exists(file)) return;
        try {
            JsonObject root = JsonParser.parseString(Files.readString(file)).getAsJsonObject();
            JsonObject n = root.has("notes") ? root.getAsJsonObject("notes") : root;
            for (String key : n.keySet()) notes.put(key, n.get(key).getAsString());
            DragonscaleBridge.LOG.info("[questbridge] loaded {} item notes", notes.size());
        } catch (Exception e) {
            DragonscaleBridge.LOG.warn("[questbridge] could not read {}: {}", file, e.toString());
        }
    }

    public JsonObject all() {
        JsonObject out = new JsonObject();
        JsonObject n = new JsonObject();
        notes.forEach(n::addProperty);
        out.add("notes", n);
        out.addProperty("count", notes.size());
        return out;
    }

    public String get(String id) {
        return notes.getOrDefault(id, "");
    }

    /** An empty note removes the entry rather than storing a blank. */
    public synchronized void set(String id, String text) throws IOException {
        if (text == null || text.isBlank()) notes.remove(id);
        else notes.put(id, text.strip());
        save();
    }

    /**
     * Written through a temporary file. Losing a thousand notes to a half-written
     * file would be a miserable way to find out the disk filled up.
     */
    private void save() throws IOException {
        Files.createDirectories(file.getParent());
        Path tmp = file.resolveSibling(file.getFileName() + ".tmp");
        JsonObject out = new JsonObject();
        JsonObject n = new JsonObject();
        notes.forEach(n::addProperty);
        out.add("notes", n);
        Files.writeString(tmp, GSON.toJson(out), StandardCharsets.UTF_8);
        Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING);
    }
}
