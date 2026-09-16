<script setup lang="ts">
// 树节点图标优先按 LDAP objectClass 的语义渲染；老服务端没有返回
// objectClass 时，才按 DN 的 RDN 类型兼容兜底。树行与过滤结果行共用。
import { computed } from "vue";
import { Building2, Database, Folder, FolderOpen, Globe, Link2, Server, Tag, User, Users } from "@lucide/vue";
import { dnNodeKind, objectClassNodeKind, type DnNodeKind, type ObjectClassNodeKind } from "../lib/dnTree";

const props = withDefaults(
  defineProps<{
    dn: string;
    baseDn?: string;
    objectClass?: string[];
    expanded?: boolean;
  }>(),
  { baseDn: "", objectClass: () => [], expanded: false },
);

type TreeIconKind = DnNodeKind | ObjectClassNodeKind;

const kind = computed<TreeIconKind>(() =>
  props.objectClass.length > 0 ? objectClassNodeKind(props.objectClass) : dnNodeKind(props.dn, props.baseDn),
);

const icon = computed(() => {
  switch (kind.value) {
    case "root":
      return Database;
    case "dc":
      return Globe;
    case "ou":
      return props.expanded ? FolderOpen : Folder;
    case "cn":
    case "uid":
      return User;
    case "o":
    case "organization":
      return Building2;
    case "container":
      return props.expanded ? FolderOpen : Folder;
    case "person":
      return User;
    case "group":
      return Users;
    case "application":
    case "device":
      return Server;
    case "alias":
      return Link2;
    case "domain":
      return Globe;
    default:
      return Tag;
  }
});

// 逐类配色（DC=青 / OU=琥珀 / 人=蓝 / 组织=翠绿 / 根=紫 / 其他=灰），
// 选中态不清色——颜色本身就是识别手段。
const KIND_CLASS: Record<TreeIconKind, string> = {
  root: "icon-violet",
  dc: "icon-cyan",
  ou: "icon-amber",
  cn: "icon-blue",
  uid: "icon-blue",
  o: "icon-emerald",
  other: "icon-neutral",
  domain: "icon-cyan",
  container: "icon-amber",
  person: "icon-blue",
  group: "icon-violet",
  organization: "icon-emerald",
  application: "icon-cyan",
  device: "icon-blue",
  alias: "icon-amber",
};
</script>

<template>
  <component :is="icon" class="tree-kind-icon" :class="KIND_CLASS[kind]" aria-hidden="true" />
</template>
