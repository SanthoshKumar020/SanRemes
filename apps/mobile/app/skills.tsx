import { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  RefreshControl,
  TextInput,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Colors, Spacing, FontSize, BorderRadius } from "../lib/theme";
import { fetchMarketplaceSkills } from "../lib/api";
import type { Skill } from "../lib/types";

// ── Skill Card ──────────────────────────────────────────────────────

function SkillCard({
  skill,
  onPress,
}: {
  skill: Skill;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity style={styles.card} onPress={onPress}>
      <View style={styles.cardHeader}>
        <View style={styles.cardIcon}>
          <Ionicons name="cube" size={20} color={Colors.gold} />
        </View>
        <View style={styles.cardInfo}>
          <Text style={styles.cardName} numberOfLines={1}>
            {skill.name}
          </Text>
          {skill.version && (
            <Text style={styles.cardVersion}>v{skill.version}</Text>
          )}
        </View>
        {skill.category && (
          <View style={styles.categoryBadge}>
            <Text style={styles.categoryText}>{skill.category}</Text>
          </View>
        )}
      </View>

      <Text style={styles.cardDescription} numberOfLines={2}>
        {skill.description}
      </Text>

      {skill.tags && skill.tags.length > 0 && (
        <View style={styles.tagsRow}>
          {skill.tags.slice(0, 4).map((tag) => (
            <View key={tag} style={styles.tag}>
              <Text style={styles.tagText}>{tag}</Text>
            </View>
          ))}
          {skill.tags.length > 4 && (
            <Text style={styles.tagMore}>+{skill.tags.length - 4}</Text>
          )}
        </View>
      )}

      {skill.author && (
        <Text style={styles.cardAuthor}>by {skill.author}</Text>
      )}
    </TouchableOpacity>
  );
}

// ── Skills Screen ───────────────────────────────────────────────────

export default function SkillsScreen() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("");

  const loadSkills = useCallback(async () => {
    try {
      const data = await fetchMarketplaceSkills(
        search || undefined,
        selectedCategory || undefined
      );
      setSkills(data);
    } catch {
      // Silent fail
    }
  }, [search, selectedCategory]);

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  useEffect(() => {
    const id = setInterval(loadSkills, 30000);
    return () => clearInterval(id);
  }, [loadSkills]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadSkills();
    setRefreshing(false);
  }, [loadSkills]);

  // Extract unique categories
  const categories = Array.from(
    new Set(skills.map((s) => s.category).filter(Boolean))
  );

  return (
    <View style={styles.container}>
      {/* Search bar */}
      <View style={styles.searchBar}>
        <Ionicons name="search" size={16} color={Colors.textMuted} />
        <TextInput
          style={styles.searchInput}
          value={search}
          onChangeText={setSearch}
          placeholder="Search skills..."
          placeholderTextColor={Colors.textMuted}
          returnKeyType="search"
        />
        {search.length > 0 && (
          <TouchableOpacity onPress={() => setSearch("")}>
            <Ionicons name="close-circle" size={16} color={Colors.textMuted} />
          </TouchableOpacity>
        )}
      </View>

      {/* Category filter */}
      {categories.length > 0 && (
        <FlatList
          horizontal
          data={[{ label: "All", value: "" }, ...categories.map((c) => ({ label: c!, value: c! }))]}
          keyExtractor={(item) => item.value}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[
                styles.categoryBtn,
                selectedCategory === item.value && styles.categoryBtnActive,
              ]}
              onPress={() => setSelectedCategory(item.value)}
            >
              <Text
                style={[
                  styles.categoryBtnText,
                  selectedCategory === item.value && styles.categoryBtnTextActive,
                ]}
              >
                {item.label}
              </Text>
            </TouchableOpacity>
          )}
          showsHorizontalScrollIndicator={false}
          style={styles.categoryBar}
          contentContainerStyle={styles.categoryBarContent}
        />
      )}

      {/* Skills list */}
      <FlatList
        data={skills}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <SkillCard skill={item} onPress={() => {}} />
        )}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={Colors.gold}
          />
        }
        contentContainerStyle={
          skills.length === 0 ? styles.emptyContainer : undefined
        }
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Ionicons
              name="cube-outline"
              size={48}
              color={Colors.textMuted}
            />
            <Text style={styles.emptyText}>
              {search ? "No skills found" : "Loading skills..."}
            </Text>
            <Text style={styles.emptySubtext}>
              {search
                ? "Try a different search term"
                : "Skills will appear here"}
            </Text>
          </View>
        }
      />
    </View>
  );
}

// ── Styles ──────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    margin: Spacing.md,
    marginBottom: Spacing.sm,
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    gap: Spacing.sm,
  },
  searchInput: {
    flex: 1,
    fontSize: FontSize.md,
    color: Colors.textPrimary,
    paddingVertical: Spacing.xs,
  },
  categoryBar: {
    maxHeight: 40,
  },
  categoryBarContent: {
    paddingHorizontal: Spacing.md,
    gap: Spacing.xs,
  },
  categoryBtn: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
    borderRadius: BorderRadius.full,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.borderLight,
  },
  categoryBtnActive: {
    backgroundColor: Colors.navy,
    borderColor: Colors.navy,
  },
  categoryBtnText: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  categoryBtnTextActive: {
    color: Colors.white,
    fontWeight: "600",
  },
  card: {
    backgroundColor: Colors.surface,
    marginHorizontal: Spacing.md,
    marginTop: Spacing.md,
    borderRadius: BorderRadius.lg,
    padding: Spacing.lg,
    borderWidth: 1,
    borderColor: Colors.borderLight,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: Spacing.sm,
    gap: Spacing.sm,
  },
  cardIcon: {
    width: 36,
    height: 36,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.gold + "15",
    alignItems: "center",
    justifyContent: "center",
  },
  cardInfo: {
    flex: 1,
  },
  cardName: {
    fontSize: FontSize.md,
    fontWeight: "600",
    color: Colors.textPrimary,
  },
  cardVersion: {
    fontSize: FontSize.xs,
    color: Colors.textMuted,
  },
  categoryBadge: {
    paddingHorizontal: Spacing.sm,
    paddingVertical: 2,
    borderRadius: BorderRadius.sm,
    backgroundColor: Colors.navy + "10",
  },
  categoryText: {
    fontSize: FontSize.xs,
    color: Colors.navy,
    fontWeight: "500",
  },
  cardDescription: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginBottom: Spacing.sm,
    lineHeight: 18,
  },
  tagsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: Spacing.xs,
    marginBottom: Spacing.sm,
  },
  tag: {
    paddingHorizontal: Spacing.sm,
    paddingVertical: 2,
    borderRadius: BorderRadius.sm,
    backgroundColor: Colors.background,
    borderWidth: 1,
    borderColor: Colors.borderLight,
  },
  tagText: {
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
  },
  tagMore: {
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    paddingVertical: 2,
  },
  cardAuthor: {
    fontSize: FontSize.xs,
    color: Colors.textMuted,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  emptyState: {
    alignItems: "center",
    gap: Spacing.sm,
  },
  emptyText: {
    fontSize: FontSize.lg,
    fontWeight: "600",
    color: Colors.textPrimary,
  },
  emptySubtext: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
});
