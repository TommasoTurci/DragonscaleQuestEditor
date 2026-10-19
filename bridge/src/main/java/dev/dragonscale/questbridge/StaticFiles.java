package dev.dragonscale.questbridge;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;
import java.util.Map;

/**
 * Serves the editor itself, so the whole thing is one URL on one port: open
 * {@code http://<server>:25580/} on a phone or a laptop and it works, with nothing
 * to install and no tunnel.
 *
 * <p>Files are read from a directory on disk when one exists, and from the jar
 * otherwise. The directory wins so the app can be edited on the server and
 * refreshed in the browser without rebuilding and redeploying the mod; the baked-in
 * copy is what makes a fresh install work with nothing but the jar.
 *
 * <p>No authentication here. The app shell is not a secret — the data behind
 * {@code /api} is, and that is where the token is checked.
 */
public final class StaticFiles implements HttpHandler {
    private static final Map<String, String> TYPES = Map.ofEntries(
        Map.entry("html", "text/html; charset=utf-8"),
        Map.entry("js", "text/javascript; charset=utf-8"),
        Map.entry("css", "text/css; charset=utf-8"),
        Map.entry("json", "application/json; charset=utf-8"),
        Map.entry("png", "image/png"),
        Map.entry("svg", "image/svg+xml"),
        Map.entry("webmanifest", "application/manifest+json"),
        Map.entry("ico", "image/x-icon"),
        Map.entry("woff2", "font/woff2")
    );

    private final Path root;          // may not exist; jar is the fallback
    private final String resourceBase;
    private final String urlPrefix;
    private final boolean spa;        // unknown paths fall back to index.html

    public StaticFiles(Path root, String resourceBase, String urlPrefix, boolean spa) {
        this.root = root;
        this.resourceBase = resourceBase;
        this.urlPrefix = urlPrefix;
        this.spa = spa;
    }

    @Override
    public void handle(HttpExchange x) throws IOException {
        String path = URLDecoder.decode(x.getRequestURI().getPath(), StandardCharsets.UTF_8);
        if (path.startsWith(urlPrefix)) path = path.substring(urlPrefix.length());
        if (path.isEmpty() || path.equals("/")) path = "/index.html";

        // A request cannot climb out of the served directory.
        String clean = Path.of(path).normalize().toString().replace('\\', '/');
        if (clean.contains("..")) {
            respond(x, 400, "text/plain", "bad path".getBytes(StandardCharsets.UTF_8));
            return;
        }
        if (clean.startsWith("/")) clean = clean.substring(1);

        byte[] body = read(clean);
        if (body == null && spa) {
            body = read("index.html");          // client-side routing
            clean = "index.html";
        }
        if (body == null) {
            respond(x, 404, "text/plain", "not found".getBytes(StandardCharsets.UTF_8));
            return;
        }
        // Icons are content-addressed by the pack build and never change in place;
        // the app itself must not be cached or an update would not reach anyone.
        if (urlPrefix.startsWith("/icons")) {
            x.getResponseHeaders().add("Cache-Control", "public, max-age=604800, immutable");
        } else {
            x.getResponseHeaders().add("Cache-Control", "no-cache");
        }
        respond(x, 200, contentType(clean), body);
    }

    private byte[] read(String rel) throws IOException {
        if (root != null) {
            Path f = root.resolve(rel);
            if (Files.isRegularFile(f)) return Files.readAllBytes(f);
        }
        try (InputStream in = StaticFiles.class.getResourceAsStream(resourceBase + "/" + rel)) {
            return in == null ? null : in.readAllBytes();
        }
    }

    private static String contentType(String name) {
        int dot = name.lastIndexOf('.');
        String ext = dot < 0 ? "" : name.substring(dot + 1).toLowerCase(Locale.ROOT);
        return TYPES.getOrDefault(ext, "application/octet-stream");
    }

    private static void respond(HttpExchange x, int code, String type, byte[] body) throws IOException {
        x.getResponseHeaders().add("Content-Type", type);
        x.sendResponseHeaders(code, body.length);
        try (OutputStream out = x.getResponseBody()) {
            out.write(body);
        }
    }
}
