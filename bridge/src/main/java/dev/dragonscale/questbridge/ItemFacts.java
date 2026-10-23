package dev.dragonscale.questbridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.item.ArmorItem;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.TieredItem;
import net.minecraft.world.level.block.Block;

import java.lang.reflect.Method;

/**
 * What the server can say about an item with certainty.
 *
 * <p>Worth being exact about the limits, because they are not obvious. The
 * server knows an item's class, so it can tell you that the class <em>overrides</em>
 * {@code use} — that right-clicking it does something — by checking which class
 * declares the method. It cannot tell you what that something is. "Right-click
 * does something" and "right-click opens a filter configuration screen" are
 * different questions, and only the first is in the data.
 *
 * <p>Likewise it knows which creative tab an item is in, which is the author's
 * own grouping and the closest thing to "what is this for" that exists as data —
 * but it is a grouping, not a purpose.
 *
 * <p>So this is deliberately a list of capabilities, not an explanation. The
 * explanation comes from a wiki, or from someone who has used the thing.
 */
public final class ItemFacts {
    private ItemFacts() {}

    public static JsonObject of(ItemStack stack) {
        JsonObject out = new JsonObject();
        Item item = stack.getItem();
        out.addProperty("class", item.getClass().getSimpleName());
        out.addProperty("stackSize", item.getDefaultMaxStackSize());

        if (stack.isDamageableItem()) out.addProperty("durability", stack.getMaxDamage());
        if (item instanceof TieredItem tiered) {
            out.addProperty("tier", tiered.getTier().toString());
        }
        if (item instanceof ArmorItem armor) {
            out.addProperty("armorSlot", armor.getEquipmentSlot().getName());
            out.addProperty("armor", armor.getDefense());
        }
        if (item instanceof net.minecraft.world.item.BlockItem bi) {
            Block block = bi.getBlock();
            out.addProperty("placesBlock", true);
            out.addProperty("blockId", BuiltInRegistries.BLOCK.getKey(block).toString());
        }

        var food = stack.get(net.minecraft.core.component.DataComponents.FOOD);
        if (food != null) {
            JsonObject f = new JsonObject();
            f.addProperty("nutrition", food.nutrition());
            f.addProperty("saturation", food.saturation());
            f.addProperty("alwaysEdible", food.canAlwaysEat());
            out.add("food", f);
        }
        if (stack.isEnchantable()) out.addProperty("enchantable", true);
        if (stack.has(net.minecraft.core.component.DataComponents.FIRE_RESISTANT)) {
            out.addProperty("fireResistant", true);
        }

        // The interesting part: which behaviour the item's own class takes over.
        JsonArray does = new JsonArray();
        if (overrides(item, "use", net.minecraft.world.level.Level.class,
            net.minecraft.world.entity.player.Player.class,
            net.minecraft.world.InteractionHand.class)) does.add("right-click in the air");
        if (overrides(item, "useOn", net.minecraft.world.item.context.UseOnContext.class)) {
            does.add("right-click on a block");
        }
        if (overrides(item, "finishUsingItem", net.minecraft.world.level.Level.class,
            net.minecraft.world.entity.LivingEntity.class)) does.add("held-use, like eating or drawing");
        if (overrides(item, "hurtEnemy", ItemStack.class,
            net.minecraft.world.entity.LivingEntity.class,
            net.minecraft.world.entity.LivingEntity.class)) does.add("something on hitting a mob");
        if (overrides(item, "inventoryTick", ItemStack.class,
            net.minecraft.world.level.Level.class, net.minecraft.world.entity.Entity.class,
            int.class, boolean.class)) does.add("something while carried");
        if (overrides(item, "interactLivingEntity", ItemStack.class,
            net.minecraft.world.entity.player.Player.class,
            net.minecraft.world.entity.LivingEntity.class,
            net.minecraft.world.InteractionHand.class)) does.add("right-click on a mob");
        out.add("does", does);

        // Where its author filed it, which is a grouping rather than a purpose but
        // is the only statement of intent that exists as data.
        JsonArray tabs = new JsonArray();
        try {
            for (var entry : BuiltInRegistries.CREATIVE_MODE_TAB.entrySet()) {
                var tab = entry.getValue();
                if (tab.getDisplayItems().stream().anyMatch(s -> s.getItem() == item)) {
                    tabs.add(entry.getKey().location().toString());
                }
            }
        } catch (Exception ignored) {
            // Tab contents are built lazily and not always available; not fatal.
        }
        out.add("creativeTabs", tabs);
        return out;
    }

    /**
     * True when the item's own class takes this method over from {@link Item}.
     * That is the whole trick: {@code Item} is the base, so anything that
     * declares the method itself has behaviour there.
     */
    private static boolean overrides(Item item, String name, Class<?>... params) {
        try {
            Method m = item.getClass().getMethod(name, params);
            return m.getDeclaringClass() != Item.class;
        } catch (NoSuchMethodException | SecurityException e) {
            return false;
        }
    }
}
