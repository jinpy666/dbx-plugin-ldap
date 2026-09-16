/**
 * ag-grid 支撑层（对标 dbx-plugin-kafka 的 kafkaColumns.ts）：
 * - 结果表列定义/行视图模型：列 = dn 首列 + 条目属性并集，全部可排序/列宽拖拽/
 *   表头文本筛选；单元格显示文本与 tooltip（完整值）在此一次性算好，组件只接线。
 * - ag-grid 内置 chrome 文案（七语，键集对齐 AG_GRID_LOCALE_KEYS 守卫）。
 * - 分页页大小 / 列宽列序（columnState）按 tableKey 持久化 localStorage。
 */
import type { ColDef, ColumnState, ValueFormatterParams } from "ag-grid-community";
import type { LdapEntry } from "./api";
import { workbenchLocale } from "./i18n";

// -- 结果表行视图模型 --------------------------------------------------------------
// 字段名 = 属性名（值 = 多值 " | " 连接后的全文，供筛选/排序匹配），单元格
// 显示层的 120 字截断只发生在 valueFormatter，不影响过滤与排序语义。
// `id` 给 DbxAgGrid 的 getRowId 用（= 原始 DN，行身份稳定）。

export interface ResultRow {
  id: string;
  dn: string;
  [attribute: string]: string;
}

// 属性名与保留字段（id/dn）撞名时该列不落 VM（行身份优先）；真实目录里
// 极罕见，列仍渲染（值为空），避免覆盖 getRowId。
const RESERVED_ROW_FIELDS = new Set(["id", "dn"]);

/** 多值连接（cellText/cellTitle/VM 共用）：空数组/缺列 → 空串。 */
export function joinValues(values: string[] | undefined | null): string {
  if (!Array.isArray(values) || values.length === 0) return "";
  return values.join(" | ");
}

export function toResultRows(entries: LdapEntry[]): ResultRow[] {
  return entries.map((entry) => {
    const row: ResultRow = { id: entry.dn, dn: entry.dn };
    for (const [name, values] of Object.entries(entry.attributes)) {
      if (!RESERVED_ROW_FIELDS.has(name)) row[name] = joinValues(values);
    }
    return row;
  });
}

/** Copy a row in the current displayed-column order, using tab-separated cells. */
export function copyRowText(row: unknown, fields: string[]): string {
  if (!row || typeof row !== "object") return "";
  const source = row as Record<string, unknown>;
  return fields.map((field) => (source[field] == null ? "" : String(source[field]))).join("\t");
}

// -- 单元格显示文本 / tooltip --------------------------------------------------------
// 与旧 ResultTable 同约定：显示文本 120 字截断；title（tooltipValueGetter）
// 预算 2000 字——原生 tooltip 超长会被浏览器截断且拖慢悬浮渲染，尾部 … 标记。

export const CELL_TEXT_LIMIT = 120;
export const CELL_TITLE_LIMIT = 2000;

export function truncateCellText(text: string): string {
  return text.length > CELL_TEXT_LIMIT ? `${text.slice(0, CELL_TEXT_LIMIT - 1)}…` : text;
}

export function cellTitleText(text: string): string {
  if (!text) return "";
  return text.length > CELL_TITLE_LIMIT ? `${text.slice(0, CELL_TITLE_LIMIT)}…` : text;
}

// -- 列定义 ---------------------------------------------------------------------------

const CELL_TITLE_GETTER = (params: { value?: unknown }): string => cellTitleText(typeof params.value === "string" ? params.value : "");

const CELL_FORMATTER = (params: ValueFormatterParams): string => truncateCellText(typeof params.value === "string" ? params.value : "");

/** 属性值列：muted 弱化（旧表 cell-value 视觉延续），完整值悬停可见。 */
const VALUE_COLUMN_EXTRA = { cellClass: "result-cell-value", tooltipValueGetter: CELL_TITLE_GETTER, valueFormatter: CELL_FORMATTER } satisfies Partial<ColDef>;

export function resultColumns(attributeNames: string[]): ColDef<ResultRow>[] {
  return [
    {
      field: "dn",
      headerName: "dn",
      sortable: true,
      resizable: true,
      filter: "agTextColumnFilter",
      sort: "asc",
      flex: 2,
      minWidth: 200,
      cellClass: "mono-s",
      tooltipValueGetter: CELL_TITLE_GETTER,
      valueFormatter: CELL_FORMATTER,
    },
    ...attributeNames
      .filter((name) => !RESERVED_ROW_FIELDS.has(name))
      .map((name) => ({
        field: name,
        headerName: name,
        sortable: true,
        resizable: true,
        filter: "agTextColumnFilter",
        flex: 1,
        minWidth: 90,
        ...VALUE_COLUMN_EXTRA,
      })),
  ];
}

// -- 分页页大小持久化（对标 kafkaColumns；键前缀区分插件） ------------------------------

const PAGE_SIZE_STORAGE_PREFIX = "dbx-ldap-grid-pagesize-";
export const PAGE_SIZE_OPTIONS = [20, 50, 100, 200];
export const DEFAULT_PAGE_SIZE = 50;

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // 宿主 webview 禁用 localStorage 时的静默兜底
  }
}

export function loadPreferredPageSize(tableKey: string): number {
  const raw = storage()?.getItem(PAGE_SIZE_STORAGE_PREFIX + tableKey) ?? "";
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PAGE_SIZE;
}

export function savePreferredPageSize(tableKey: string, size: number): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(PAGE_SIZE_STORAGE_PREFIX + tableKey, String(size));
  } catch {
    // quota/private mode → 分页偏好放弃持久化即可
  }
}

// -- 列宽/列序持久化（columnState）------------------------------------------------------
// 旧表按列名记宽度（ldap.result.columnWidths.v1）；ag-grid 化后升级为整份
// columnState（宽度 + 顺序 + 隐藏态）。解析失败/缺字段按无存储处理。

const COLUMN_STATE_STORAGE_PREFIX = "dbx-ldap-grid-colstate-";

export function loadColumnState(tableKey: string): ColumnState[] | null {
  try {
    const raw = storage()?.getItem(COLUMN_STATE_STORAGE_PREFIX + tableKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => item && typeof item === "object" && typeof (item as ColumnState).colId === "string")
      ? (parsed as ColumnState[])
      : null;
  } catch {
    return null;
  }
}

export function saveColumnState(tableKey: string, state: ColumnState[]): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(COLUMN_STATE_STORAGE_PREFIX + tableKey, JSON.stringify(state));
  } catch {
    // quota/private mode → 列布局放弃持久化即可
  }
}

// -- ag-grid 内置 chrome locale（七语；键集对齐 AG_GRID_LOCALE_KEYS 守卫） ---------------
// 键集与消费点核对同 dbx-plugin-kafka（ag-grid 36.1.0 dist 实测）：分页条
// to/of/page/more/number + 翻页按钮 aria + 页大小选择器；文本过滤面板
// searchOoo/filterOoo/equals/contains/…/applyFilter；noRowsToShow 空态。

export const AG_GRID_LOCALE_KEYS = [
  "searchOoo",
  "blanks",
  "noRowsToShow",
  "page",
  "to",
  "of",
  "more",
  "number",
  "firstPage",
  "previousPage",
  "nextPage",
  "lastPage",
  "pageSizeSelectorLabel",
  "ariaPageSizeSelectorLabel",
  "filterOoo",
  "equals",
  "notEqual",
  "contains",
  "notContains",
  "startsWith",
  "endsWith",
  "greaterThan",
  "lessThan",
  "inRange",
  "andCondition",
  "orCondition",
  "applyFilter",
  "resetFilter",
  "cancelFilter",
  "dateFormatOoo",
  "before",
  "after",
  "greaterThanOrEqual",
  "lessThanOrEqual",
  "inRangeStart",
  "inRangeEnd",
  "ariaDateFilterInput",
  "invalidDate",
  "invalidNumber",
  "blank",
  "notBlank",
  "empty",
] as const;

type AgLocaleText = Record<(typeof AG_GRID_LOCALE_KEYS)[number], string>;

const AG_LOCALE_TEXT: Record<string, AgLocaleText> = {
  en: {
    searchOoo: "Search…",
    blanks: "(Blanks)",
    noRowsToShow: "No rows",
    page: "Page",
    to: "to",
    of: "of",
    more: "more",
    number: "number",
    firstPage: "First Page",
    previousPage: "Previous Page",
    nextPage: "Next Page",
    lastPage: "Last Page",
    pageSizeSelectorLabel: "Page size:",
    ariaPageSizeSelectorLabel: "Page size",
    filterOoo: "Filter…",
    equals: "Equals",
    notEqual: "Not equal",
    contains: "Contains",
    notContains: "Not contains",
    startsWith: "Starts with",
    endsWith: "Ends with",
    greaterThan: "Greater than",
    lessThan: "Less than",
    inRange: "In range",
    andCondition: "AND",
    orCondition: "OR",
    applyFilter: "Apply",
    resetFilter: "Reset",
    cancelFilter: "Cancel",
    dateFormatOoo: "yyyy-mm-dd",
    before: "Before",
    after: "After",
    greaterThanOrEqual: "Greater or equal",
    lessThanOrEqual: "Less or equal",
    inRangeStart: "From",
    inRangeEnd: "To",
    ariaDateFilterInput: "Date Filter Input",
    invalidDate: "Invalid Date",
    invalidNumber: "Invalid Number",
    blank: "Blank",
    notBlank: "Not blank",
    empty: "Empty",
  },
  "zh-CN": {
    searchOoo: "搜索…",
    blanks: "（空）",
    noRowsToShow: "暂无数据",
    page: "第",
    to: "至",
    of: "/ 共",
    more: "更多",
    number: "页",
    firstPage: "第一页",
    previousPage: "上一页",
    nextPage: "下一页",
    lastPage: "最后一页",
    pageSizeSelectorLabel: "每页条数：",
    ariaPageSizeSelectorLabel: "每页条数",
    filterOoo: "过滤…",
    equals: "等于",
    notEqual: "不等于",
    contains: "包含",
    notContains: "不包含",
    startsWith: "开头为",
    endsWith: "结尾为",
    greaterThan: "大于",
    lessThan: "小于",
    inRange: "介于",
    andCondition: "且",
    orCondition: "或",
    applyFilter: "应用",
    resetFilter: "重置",
    cancelFilter: "取消",
    dateFormatOoo: "年-月-日",
    before: "早于",
    after: "晚于",
    greaterThanOrEqual: "大于等于",
    lessThanOrEqual: "小于等于",
    inRangeStart: "起",
    inRangeEnd: "止",
    ariaDateFilterInput: "日期过滤输入",
    invalidDate: "无效日期",
    invalidNumber: "无效数字",
    blank: "为空",
    notBlank: "不为空",
    empty: "空",
  },
  "zh-TW": {
    searchOoo: "搜尋…",
    blanks: "（空）",
    noRowsToShow: "尚無資料",
    page: "第",
    to: "至",
    of: "/ 共",
    more: "更多",
    number: "頁",
    firstPage: "第一頁",
    previousPage: "上一頁",
    nextPage: "下一頁",
    lastPage: "最後一頁",
    pageSizeSelectorLabel: "每頁筆數：",
    ariaPageSizeSelectorLabel: "每頁筆數",
    filterOoo: "過濾…",
    equals: "等於",
    notEqual: "不等於",
    contains: "包含",
    notContains: "不包含",
    startsWith: "開頭為",
    endsWith: "結尾為",
    greaterThan: "大於",
    lessThan: "小於",
    inRange: "介於",
    andCondition: "且",
    orCondition: "或",
    applyFilter: "套用",
    resetFilter: "重設",
    cancelFilter: "取消",
    dateFormatOoo: "年-月-日",
    before: "早於",
    after: "晚於",
    greaterThanOrEqual: "大於等於",
    lessThanOrEqual: "小於等於",
    inRangeStart: "起",
    inRangeEnd: "迄",
    ariaDateFilterInput: "日期過濾輸入",
    invalidDate: "無效日期",
    invalidNumber: "無效數字",
    blank: "空白",
    notBlank: "非空白",
    empty: "空",
  },
  es: {
    searchOoo: "Buscar…",
    blanks: "(Vacíos)",
    noRowsToShow: "Sin filas",
    page: "Página",
    to: "a",
    of: "de",
    more: "más",
    number: "número",
    firstPage: "Primera página",
    previousPage: "Página anterior",
    nextPage: "Página siguiente",
    lastPage: "Última página",
    pageSizeSelectorLabel: "Tamaño de página:",
    ariaPageSizeSelectorLabel: "Tamaño de página",
    filterOoo: "Filtrar…",
    equals: "Igual a",
    notEqual: "Distinto de",
    contains: "Contiene",
    notContains: "No contiene",
    startsWith: "Empieza por",
    endsWith: "Termina en",
    greaterThan: "Mayor que",
    lessThan: "Menor que",
    inRange: "Entre",
    andCondition: "Y",
    orCondition: "O",
    applyFilter: "Aplicar",
    resetFilter: "Restablecer",
    cancelFilter: "Cancelar",
    dateFormatOoo: "aaaa-mm-dd",
    before: "Antes de",
    after: "Después de",
    greaterThanOrEqual: "Mayor o igual",
    lessThanOrEqual: "Less or equal",
    inRangeStart: "Desde",
    inRangeEnd: "Hasta",
    ariaDateFilterInput: "Entrada de filtro de fecha",
    invalidDate: "Fecha no válida",
    invalidNumber: "Número no válido",
    blank: "En blanco",
    notBlank: "No en blanco",
    empty: "Vacío",
  },
  it: {
    searchOoo: "Cerca…",
    blanks: "(Vuote)",
    noRowsToShow: "Nessuna riga",
    page: "Pagina",
    to: "a",
    of: "di",
    more: "altro",
    number: "numero",
    firstPage: "Prima pagina",
    previousPage: "Pagina precedente",
    nextPage: "Pagina successiva",
    lastPage: "Ultima pagina",
    pageSizeSelectorLabel: "Dimensione pagina:",
    ariaPageSizeSelectorLabel: "Dimensione pagina",
    filterOoo: "Filtra…",
    equals: "Uguale a",
    notEqual: "Diverso da",
    contains: "Contiene",
    notContains: "Non contiene",
    startsWith: "Inizia con",
    endsWith: "Finisce con",
    greaterThan: "Maggiore di",
    lessThan: "Minore di",
    inRange: "Nell'intervallo",
    andCondition: "E",
    orCondition: "O",
    applyFilter: "Applica",
    resetFilter: "Reimposta",
    cancelFilter: "Annulla",
    dateFormatOoo: "aaaa-mm-gg",
    before: "Prima del",
    after: "Dopo il",
    greaterThanOrEqual: "Maggiore o uguale",
    lessThanOrEqual: "Minore o uguale",
    inRangeStart: "Da",
    inRangeEnd: "A",
    ariaDateFilterInput: "Input filtro data",
    invalidDate: "Data non valida",
    invalidNumber: "Numero non valido",
    blank: "Vuoto",
    notBlank: "Non vuoto",
    empty: "Nessun valore",
  },
  ja: {
    searchOoo: "検索…",
    blanks: "（空）",
    noRowsToShow: "データがありません",
    page: "ページ",
    to: "～",
    of: "/",
    more: "続き",
    number: "番号",
    firstPage: "最初のページ",
    previousPage: "前のページ",
    nextPage: "次のページ",
    lastPage: "最後のページ",
    pageSizeSelectorLabel: "ページサイズ：",
    ariaPageSizeSelectorLabel: "ページサイズ",
    filterOoo: "フィルター…",
    equals: "一致",
    notEqual: "不一致",
    contains: "含む",
    notContains: "含まない",
    startsWith: "前方一致",
    endsWith: "後方一致",
    greaterThan: "より大きい",
    lessThan: "より小さい",
    inRange: "範囲内",
    andCondition: "かつ",
    orCondition: "または",
    applyFilter: "適用",
    resetFilter: "リセット",
    cancelFilter: "キャンセル",
    dateFormatOoo: "yyyy-mm-dd",
    before: "以前",
    after: "以降",
    greaterThanOrEqual: "以上",
    lessThanOrEqual: "以下",
    inRangeStart: "開始",
    inRangeEnd: "終了",
    ariaDateFilterInput: "日付フィルター入力",
    invalidDate: "無効な日付",
    invalidNumber: "無効な数値",
    blank: "空欄",
    notBlank: "空欄以外",
    empty: "空",
  },
  "pt-BR": {
    searchOoo: "Pesquisar…",
    blanks: "(Vazios)",
    noRowsToShow: "Sem linhas",
    page: "Página",
    to: "a",
    of: "de",
    more: "mais",
    number: "número",
    firstPage: "Primeira página",
    previousPage: "Página anterior",
    nextPage: "Próxima página",
    lastPage: "Última página",
    pageSizeSelectorLabel: "Tamanho da página:",
    ariaPageSizeSelectorLabel: "Tamanho da página",
    filterOoo: "Filtrar…",
    equals: "Igual a",
    notEqual: "Diferente de",
    contains: "Contém",
    notContains: "Não contém",
    startsWith: "Começa com",
    endsWith: "Termina com",
    greaterThan: "Maior que",
    lessThan: "Menor que",
    inRange: "No intervalo",
    andCondition: "E",
    orCondition: "OU",
    applyFilter: "Aplicar",
    resetFilter: "Redefinir",
    cancelFilter: "Cancelar",
    dateFormatOoo: "aaaa-mm-dd",
    before: "Antes de",
    after: "Depois de",
    greaterThanOrEqual: "Maior ou igual",
    lessThanOrEqual: "Menor ou igual",
    inRangeStart: "De",
    inRangeEnd: "Até",
    ariaDateFilterInput: "Entrada do filtro de data",
    invalidDate: "Data inválida",
    invalidNumber: "Número inválido",
    blank: "Em branco",
    notBlank: "Não em branco",
    empty: "Vazio",
  },
};

/** 当前工作台 locale 对应的 ag-grid 内置文案（建表时读取；locale 切换经重建表生效）。 */
export function agGridLocaleText(): AgLocaleText {
  return AG_LOCALE_TEXT[workbenchLocale.value] ?? AG_LOCALE_TEXT["zh-CN"];
}
