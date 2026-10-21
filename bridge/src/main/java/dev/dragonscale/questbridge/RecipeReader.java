package dev.dragonscale.questbridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mojang.serialization.Codec;
import com.mojang.serialization.JsonOps;
import com.mojang.serialization.MapCodec;
import net.minecraft.core.NonNullList;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.RegistryOps;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.crafting.AbstractCookingRecipe;
import net.minecraft.world.item.crafting.Ingredient;
import net.minecraft.world.item.crafting.Recipe;
import net.minecraft.world.item.crafting.RecipeHolder;
import net.minecraft.world.item.crafting.ShapedRecipe;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Answers "what makes this?" and "what is this used in?" from the server's own
 * recipe manager.
 *
 * <p>This is the half of the workflow the editor was missing. Composing a quest
 * book means looking at an item, looking up how it is made, and writing a quest
 * around that — which currently means alt-tabbing into the game and using JEI.
 * The server already knows every recipe the pack loaded, so it may as well say.
 *
 * <p>Nothing here knows about any particular mod. A recipe is asked for its
 * ingredients and its result through the interfaces every recipe implements, so
 * Create's milling and a vanilla crafting table are read the same way. A recipe
 * that expresses its inputs some other way reports none, and the editor says so
 * rather than pretending it has nothing in it.
 */
public final class RecipeReader {
    /** Per request. A tag-driven ingredient can accept hundreds of items. */
    private static final int MAX_PER_SLOT = 14;
    private static final int MAX_RESULTS = 60;

    private static List<RecipeHolder<?>> snapshot = List.of();
    private static Map<String, List<Integer>> makes = Map.of();
    private static Map<String, List<Integer>> uses = Map.of();
    private static int builtFrom = -1;

    private RecipeReader() {}

    public static JsonObject forItem(MinecraftServer mc, String item) {
        index(mc);
        JsonObject out = new JsonObject();
        out.addProperty("item", item);
        out.add("makes", render(mc, makes.get(item)));
        out.add("uses", render(mc, uses.get(item)));
        out.addProperty("total", snapshot.size());
        return out;
    }

    private static JsonArray render(MinecraftServer mc, List<Integer> hits) {
        JsonArray arr = new JsonArray();
        if (hits == null) return arr;
        for (int i = 0; i < hits.size() && arr.size() < MAX_RESULTS; i++) {
            JsonObject r = one(mc, snapshot.get(hits.get(i)));
            if (r != null) arr.add(r);
        }
        return arr;
    }

    private static JsonObject one(MinecraftServer mc, RecipeHolder<?> holder) {
        try {
            Recipe<?> recipe = holder.value();
            JsonObject out = new JsonObject();
            out.addProperty("id", holder.id().toString());
            var typeKey = BuiltInRegistries.RECIPE_TYPE.getKey(recipe.getType());
            out.addProperty("type", typeKey == null ? "unknown" : typeKey.toString());

            ItemStack result = result(mc, recipe);
            if (!result.isEmpty()) {
                JsonObject res = new JsonObject();
                res.addProperty("id", idOf(result));
                res.addProperty("count", result.getCount());
                out.add("output", res);
            }

            // A shaped recipe's layout is the point of it, so its blank slots are
            // kept and the grid size is reported. Everything else is a bag of
            // ingredients and empties would just be noise.
            boolean shaped = recipe instanceof ShapedRecipe;
            if (shaped) {
                ShapedRecipe sr = (ShapedRecipe) recipe;
                JsonObject grid = new JsonObject();
                grid.addProperty("w", sr.getWidth());
                grid.addProperty("h", sr.getHeight());
                out.add("grid", grid);
            }

            JsonArray inputs = new JsonArray();
            for (Ingredient ing : ingredients(recipe)) {
                boolean blank = ing == null || ing.isEmpty();
                if (blank && !shaped) continue;
                JsonArray slot = new JsonArray();
                if (!blank) {
                    ItemStack[] items = ing.getItems();
                    for (int i = 0; i < items.length && i < MAX_PER_SLOT; i++) {
                        slot.add(idOf(items[i]));
                    }
                    if (items.length > MAX_PER_SLOT) out.addProperty("truncated", true);
                }
                if (shaped || !slot.isEmpty()) inputs.add(slot);
            }
            out.add("inputs", inputs);

            // Smelting and friends: how long, and what it is worth.
            if (recipe instanceof AbstractCookingRecipe cook) {
                out.addProperty("time", cook.getCookingTime());
                out.addProperty("xp", cook.getExperience());
            }

            // Everything a mod's own recipe says that these fields cannot carry —
            // Create's processing times and output chances, for instance. Asking
            // the recipe to serialize itself is the only way to get at that
            // without a line of code per mod, which is the thing this project has
            // avoided everywhere else. Vanilla crafting is skipped: the grid above
            // already says everything, and the JSON would just be noise.
            if (!shaped && !(recipe instanceof AbstractCookingRecipe)) {
                raw(mc, recipe).ifPresent(j -> out.add("raw", j));
            }
            return out;
        } catch (Exception e) {
            // One badly behaved modded recipe must not take the lookup with it.
            return null;
        }
    }

    /**
     * The recipe as its own serializer writes it, which is the datapack JSON. The
     * registry-aware ops matter: ingredients encode through holder references and
     * plain JsonOps cannot resolve them.
     */
    @SuppressWarnings({ "unchecked", "rawtypes" })
    private static Optional<JsonElement> raw(MinecraftServer mc, Recipe<?> recipe) {
        try {
            MapCodec codec = recipe.getSerializer().codec();
            var ops = RegistryOps.create(JsonOps.INSTANCE, mc.registryAccess());
            JsonElement json = ((Codec<Recipe<?>>) codec.codec())
                .encodeStart(ops, recipe).result().orElse(null);
            // A recipe that encodes to a novel is not worth sending sixty times
            // over, and nothing useful is that long.
            if (json == null || json.toString().length() > 4000) return Optional.empty();
            return Optional.of(json);
        } catch (Throwable t) {
            // Serializers are mod code and some of them are not safe to call out
            // of context. A missing raw view is a missing detail, not a failure.
            return Optional.empty();
        }
    }

    private static ItemStack result(MinecraftServer mc, Recipe<?> recipe) {
        try {
            ItemStack s = recipe.getResultItem(mc.registryAccess());
            return s == null ? ItemStack.EMPTY : s;
        } catch (Exception e) {
            return ItemStack.EMPTY;
        }
    }

    private static NonNullList<Ingredient> ingredients(Recipe<?> recipe) {
        try {
            NonNullList<Ingredient> l = recipe.getIngredients();
            return l == null ? NonNullList.create() : l;
        } catch (Exception e) {
            return NonNullList.create();
        }
    }

    private static String idOf(ItemStack stack) {
        return BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
    }

    /**
     * Builds both directions once. Resolving every ingredient of every recipe is
     * not free — a tag-driven one has to be expanded — so it happens the first
     * time somebody looks something up rather than at startup, and the cost is
     * logged so it is not a mystery if it ever becomes one.
     */
    private static synchronized void index(MinecraftServer mc) {
        var all = mc.getRecipeManager().getRecipes();
        if (builtFrom == all.size() && !snapshot.isEmpty()) return;

        long started = System.currentTimeMillis();
        List<RecipeHolder<?>> list = new ArrayList<>(all);
        Map<String, List<Integer>> byOutput = new HashMap<>();
        Map<String, List<Integer>> byInput = new HashMap<>();

        for (int i = 0; i < list.size(); i++) {
            RecipeHolder<?> holder = list.get(i);
            try {
                ItemStack result = result(mc, holder.value());
                if (!result.isEmpty()) {
                    byOutput.computeIfAbsent(idOf(result), k -> new ArrayList<>()).add(i);
                }
                // A slot that accepts fifty items makes this recipe show up under
                // all fifty, which is what "used in" means and what JEI does.
                Set<String> seen = new LinkedHashSet<>();
                for (Ingredient ing : ingredients(holder.value())) {
                    if (ing == null || ing.isEmpty()) continue;
                    for (ItemStack s : ing.getItems()) seen.add(idOf(s));
                }
                for (String id : seen) {
                    byInput.computeIfAbsent(id, k -> new ArrayList<>()).add(i);
                }
            } catch (Exception ignored) {
                // Skip it; one recipe is not worth losing the index over.
            }
        }

        snapshot = list;
        makes = byOutput;
        uses = byInput;
        builtFrom = list.size();
        DragonscaleBridge.LOG.info("[questbridge] indexed {} recipes in {} ms",
            list.size(), System.currentTimeMillis() - started);
    }
}
