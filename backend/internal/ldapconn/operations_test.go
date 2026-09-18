package ldapconn

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"

	ldap "github.com/go-ldap/ldap/v3"

	"io.dbx.ldap.plugin/internal/lifecycle"
)

// operations_test.go：operations 层纯逻辑单测（不连网）。
// 策略拒绝发生在 WithConn 惰性建连之前，故可在无网络环境下验证门禁与审计。

// connectProfile 经 lifecycle params 注入一个连接表条目（不 dial）。
func connectProfile(t *testing.T, svc *Service, id string, cfg map[string]any) {
	t.Helper()
	params := &lifecycle.Params{
		Connection: lifecycle.Connection{
			ID:             id,
			Name:           "test-" + id,
			Host:           "ldap://127.0.0.1:1",
			Username:       "u",
			ExternalConfig: cfg,
			Secrets:        map[string]any{"bind_password": "s3cret"},
		},
		Runtime: lifecycle.Runtime{Host: "127.0.0.1", Port: 1},
	}
	if err := svc.Connect(params); err != nil {
		t.Fatalf("Connect: %v", err)
	}
}

func newAuditService() (*Service, *[]AuditRecord) {
	records := &[]AuditRecord{}
	svc := NewService()
	svc.Audit = func(rec AuditRecord) {
		*records = append(*records, rec)
	}
	return svc, records
}

func TestUnknownConnectionRejected(t *testing.T) {
	svc, records := newAuditService()
	if _, err := svc.Search(context.Background(), LDAPSearchRequest{ConnectionID: "missing"}); err == nil ||
		!strings.Contains(err.Error(), "not connected") {
		t.Errorf("search unknown conn err = %v", err)
	}
	if err := svc.DeleteEntry(context.Background(), LDAPDeleteEntryRequest{ConnectionID: "missing", DN: "cn=x"}); err == nil {
		t.Errorf("delete unknown conn should fail")
	}
	if len(*records) != 0 {
		t.Errorf("no audit expected for unknown connection, got %v", *records)
	}
}

func TestSearchParameterValidation(t *testing.T) {
	svc, records := newAuditService()
	connectProfile(t, svc, "c1", nil)
	ctx := context.Background()

	// baseDn 缺省（profile 也无）→ 报错
	if _, err := svc.Search(ctx, LDAPSearchRequest{ConnectionID: "c1", Filter: "(objectClass=*)"}); err == nil ||
		err.Error() != "baseDn is required" {
		t.Errorf("empty baseDn err = %v", err)
	}
	// 非法 filter（smoke S10）
	if _, err := svc.Search(ctx, LDAPSearchRequest{ConnectionID: "c1", BaseDN: "dc=x", Filter: "objectClass=*"}); err == nil ||
		!strings.HasPrefix(err.Error(), "invalid ldap filter") {
		t.Errorf("invalid filter err = %v", err)
	}
	// 读白名单拒绝（smoke S8）
	whitelisted, whitelistedRecs := newAuditService()
	connectProfile(t, whitelisted, "c2", map[string]any{"allowed_base_dns": "dc=example,dc=com"})
	_, err := whitelisted.Search(ctx, LDAPSearchRequest{ConnectionID: "c2", BaseDN: "dc=outside,dc=com", Filter: "(objectClass=*)"})
	if err == nil || !strings.Contains(err.Error(), "outside allowed base DNs") {
		t.Fatalf("out-of-whitelist search err = %v", err)
	}
	recs := *whitelistedRecs
	if len(recs) != 1 || recs[0].Action != "read-policy" || recs[0].Result != "denied" {
		t.Errorf("audit records = %+v", recs)
	}
	_ = svc
	_ = records
}

func TestCountParameterValidation(t *testing.T) {
	svc, records := newAuditService()
	connectProfile(t, svc, "c1", nil)
	ctx := context.Background()

	// 未知连接拒绝
	if _, err := svc.Count(ctx, LDAPCountRequest{ConnectionID: "missing"}); err == nil ||
		!strings.Contains(err.Error(), "not connected") {
		t.Errorf("count unknown conn err = %v", err)
	}
	// baseDn 缺省（profile 也无）→ 报错
	if _, err := svc.Count(ctx, LDAPCountRequest{ConnectionID: "c1"}); err == nil ||
		err.Error() != "baseDn is required" {
		t.Errorf("empty baseDn err = %v", err)
	}
	// 非法 filter 拒绝
	if _, err := svc.Count(ctx, LDAPCountRequest{ConnectionID: "c1", BaseDN: "dc=x", Filter: "objectClass=*"}); err == nil ||
		!strings.HasPrefix(err.Error(), "invalid ldap filter") {
		t.Errorf("invalid filter err = %v", err)
	}
	// 读白名单拒绝 + 审计 denied
	whitelisted, whitelistedRecs := newAuditService()
	connectProfile(t, whitelisted, "c2", map[string]any{"allowed_base_dns": "dc=example,dc=com"})
	_, err := whitelisted.Count(ctx, LDAPCountRequest{ConnectionID: "c2", BaseDN: "dc=outside,dc=com"})
	if err == nil || !strings.Contains(err.Error(), "outside allowed base DNs") {
		t.Fatalf("out-of-whitelist count err = %v", err)
	}
	recs := *whitelistedRecs
	if len(recs) != 1 || recs[0].Action != "read-policy" || recs[0].Result != "denied" {
		t.Errorf("audit records = %+v", recs)
	}
	_ = records
}

func TestAddEntryPolicyDenials(t *testing.T) {
	ctx := context.Background()

	// 1) read_only（smoke S6）
	ro, roRecs := newAuditService()
	connectProfile(t, ro, "ro", map[string]any{"read_only": true, "base_dn": "dc=example,dc=com"})
	err := ro.AddEntry(ctx, LDAPAddEntryRequest{ConnectionID: "ro", DN: "cn=x,dc=example,dc=com",
		Attributes: map[string][]string{"cn": {"x"}}})
	if err == nil || !strings.Contains(err.Error(), "read-only") {
		t.Fatalf("read-only add err = %v", err)
	}
	if recs := *roRecs; len(recs) != 1 || recs[0].Action != "write-policy" || recs[0].Result != "denied" {
		t.Errorf("read-only audit = %+v", recs)
	}

	// 2) 写白名单外
	denied, deniedRecs := newAuditService()
	connectProfile(t, denied, "w1", map[string]any{"allowed_base_dns": "dc=example,dc=com"})
	err = denied.AddEntry(ctx, LDAPAddEntryRequest{ConnectionID: "w1", DN: "cn=x,dc=outside,dc=com",
		Attributes: map[string][]string{"cn": {"x"}}})
	if err == nil || !strings.Contains(err.Error(), "outside allowed write base DNs") {
		t.Fatalf("out-of-whitelist add err = %v", err)
	}
	if recs := *deniedRecs; len(recs) != 1 || recs[0].Target != "cn=x,dc=outside,dc=com" {
		t.Errorf("denied audit = %+v", recs)
	}

	// 3) 屏蔽属性（默认表：userPassword）
	blocked, blockedRecs := newAuditService()
	connectProfile(t, blocked, "w2", nil)
	err = blocked.AddEntry(ctx, LDAPAddEntryRequest{ConnectionID: "w2", DN: "cn=x,dc=example,dc=com",
		Attributes: map[string][]string{"cn": {"x"}, "userPassword": {"p"}}})
	if err == nil || !strings.Contains(err.Error(), "blocked") {
		t.Fatalf("blocked attribute add err = %v", err)
	}

	// 4) 值校验（门禁之前）：空值报错，且不产生 write-policy 审计
	emptyVals, emptyRecs := newAuditService()
	connectProfile(t, emptyVals, "w3", nil)
	err = emptyVals.AddEntry(ctx, LDAPAddEntryRequest{ConnectionID: "w3", DN: "cn=x,dc=example,dc=com",
		Attributes: map[string][]string{"cn": {""}}})
	if err == nil || !strings.Contains(err.Error(), "cannot be empty") {
		t.Fatalf("empty value add err = %v", err)
	}
	if recs := *emptyRecs; len(recs) != 0 {
		t.Errorf("no audit expected before policy gate, got %+v", recs)
	}

	// 审计 detail 只含属性名，不含属性值（凭据红线）
	for _, rec := range append(*blockedRecs, *roRecs...) {
		if strings.Contains(rec.Detail, "s3cret") || strings.Contains(rec.Detail, "\x00") {
			t.Errorf("audit must not carry values: %+v", rec)
		}
	}
}

func TestModifyDNWriteWhitelistBothDNs(t *testing.T) {
	ctx := context.Background()
	svc, recs := newAuditService()
	// 写白名单只含 dc=a：目标 DN（dc=b 下）越界 → 拒绝
	connectProfile(t, svc, "m1", map[string]any{"allowed_write_base_dns": "dc=a,dc=com"})
	err := svc.ModifyDN(ctx, LDAPModifyDNRequest{ConnectionID: "m1",
		DN: "cn=x,dc=a,dc=com", NewRDN: "cn=y", NewSuperior: "dc=b,dc=com", DeleteOldRDN: true})
	if err == nil || !strings.Contains(err.Error(), "outside allowed write base DNs") {
		t.Fatalf("destination DN outside whitelist err = %v", err)
	}
	if recs := *recs; len(recs) != 1 || recs[0].Target != "cn=y,dc=b,dc=com" {
		t.Errorf("audit should target destination DN: %+v", recs)
	}

	// 源 DN 越界（第一个门禁）
	svc2, recs2 := newAuditService()
	connectProfile(t, svc2, "m2", map[string]any{"allowed_write_base_dns": "dc=a,dc=com"})
	err = svc2.ModifyDN(ctx, LDAPModifyDNRequest{ConnectionID: "m2",
		DN: "cn=x,dc=z,dc=com", NewRDN: "cn=y", DeleteOldRDN: true})
	if err == nil || !strings.Contains(err.Error(), "outside allowed write base DNs") {
		t.Fatalf("source DN outside whitelist err = %v", err)
	}
	if recs := *recs2; len(recs) != 1 || recs[0].Target != "cn=x,dc=z,dc=com" {
		t.Errorf("audit should target source DN: %+v", recs)
	}

	// newRdn 缺失
	svc3, _ := newAuditService()
	connectProfile(t, svc3, "m3", nil)
	if err := svc3.ModifyDN(ctx, LDAPModifyDNRequest{ConnectionID: "m3", DN: "cn=x"}); err == nil ||
		err.Error() != "dn and newRdn are required" {
		t.Errorf("missing newRdn err = %v", err)
	}
}

func TestGetEntryAndRootDSEPolicy(t *testing.T) {
	ctx := context.Background()
	svc, recs := newAuditService()
	connectProfile(t, svc, "g1", map[string]any{"allowed_base_dns": "dc=example,dc=com"})

	// GetEntry 白名单外 → read-policy denied（smoke S8）
	if _, err := svc.GetEntry(ctx, LDAPGetEntryRequest{ConnectionID: "g1", DN: "cn=x,dc=outside,dc=com"}); err == nil {
		t.Fatalf("out-of-whitelist get should fail")
	}
	// GetEntry 空 DN
	if _, err := svc.GetEntry(ctx, LDAPGetEntryRequest{ConnectionID: "g1", DN: " "}); err == nil ||
		err.Error() != "dn is required" {
		t.Errorf("empty dn err = %v", err)
	}

	// RootDSE：AllowedBaseDNs 非空时禁用（沿袭）
	if _, err := svc.RootDSE(ctx, LDAPRootDSERequest{ConnectionID: "g1"}); err == nil ||
		!strings.Contains(err.Error(), "disabled when allowed base DNs are configured") {
		t.Fatalf("restricted rootDSE err = %v", err)
	}
	// Schema 同理
	if _, err := svc.SchemaMetadata(ctx, LDAPSchemaMetadataRequest{ConnectionID: "g1"}); err == nil {
		t.Fatalf("restricted schema should fail")
	}
	if recs := *recs; len(recs) != 1 { // 仅 GetEntry 的 read-policy；rootDSE/schema 沿袭不发审计
		t.Errorf("audit records = %+v", recs)
	}
}

func TestConnectionStatuses(t *testing.T) {
	svc, _ := newAuditService()
	connectProfile(t, svc, "s1", nil)
	statuses, err := svc.ConnectionStatuses()
	if err != nil {
		t.Fatalf("ConnectionStatuses err = %v", err)
	}
	if len(statuses) != 1 {
		t.Fatalf("statuses = %+v", statuses)
	}
	st := statuses[0]
	if st.ConnectionID != "s1" || st.Status != "idle" {
		t.Errorf("status = %+v", st)
	}
	// 凭据不出现
	raw := strings.Join([]string{st.Name, st.URL, st.Error}, "|")
	if strings.Contains(raw, "s3cret") {
		t.Errorf("status carries secret: %+v", st)
	}
}

type memPresetStore struct {
	presets []LDAPSearchPreset
	fail    bool
}

func (m *memPresetStore) LoadPresets() ([]LDAPSearchPreset, error) {
	if m.fail {
		return nil, context.DeadlineExceeded
	}
	return m.presets, nil
}

func (m *memPresetStore) SavePresets(presets []LDAPSearchPreset) error {
	if m.fail {
		return context.DeadlineExceeded
	}
	m.presets = presets
	return nil
}

func TestPresetsCRUD(t *testing.T) {
	svc := NewService()

	// store 未注入
	if _, err := svc.ListPresets(); err == nil {
		t.Errorf("nil store ListPresets should fail")
	}
	if _, err := svc.SavePreset(LDAPSearchPreset{Name: "x"}); err == nil {
		t.Errorf("nil store SavePreset should fail")
	}

	store := &memPresetStore{}
	svc.Presets = store

	// 空列表（nil → []）
	presets, err := svc.ListPresets()
	if err != nil || len(presets) != 0 {
		t.Fatalf("initial presets = %v, err = %v", presets, err)
	}

	// name 必填
	if _, err := svc.SavePreset(LDAPSearchPreset{}); err == nil || err.Error() != "preset name is required" {
		t.Errorf("nameless preset err = %v", err)
	}

	// 新增：id 空时生成 uuid
	saved, err := svc.SavePreset(LDAPSearchPreset{Name: "all", BaseDN: "dc=example,dc=com", Filter: "(objectClass=*)", Scope: "sub"})
	if err != nil || saved.ID == "" {
		t.Fatalf("save = %+v, err = %v", saved, err)
	}
	// upsert：同 id 覆盖
	if _, err := svc.SavePreset(LDAPSearchPreset{ID: saved.ID, Name: "all-2"}); err != nil {
		t.Fatalf("upsert err = %v", err)
	}
	presets, _ = svc.ListPresets()
	if len(presets) != 1 || presets[0].Name != "all-2" || presets[0].BaseDN != "" {
		t.Errorf("after upsert presets = %+v", presets)
	}
	// 显式 id 保留
	manual, err := svc.SavePreset(LDAPSearchPreset{ID: "  manual-id  ", Name: "m"})
	if err != nil || manual.ID != "manual-id" {
		t.Fatalf("manual id = %+v, err = %v", manual, err)
	}

	// remove：不存在报错
	if err := svc.RemovePreset("nope"); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Errorf("remove missing err = %v", err)
	}
	if err := svc.RemovePreset(saved.ID); err != nil {
		t.Fatalf("remove err = %v", err)
	}
	presets, _ = svc.ListPresets()
	if len(presets) != 1 || presets[0].ID != "manual-id" {
		t.Errorf("after remove presets = %+v", presets)
	}

	// store 故障透传
	store.fail = true
	if _, err := svc.ListPresets(); err == nil {
		t.Errorf("store failure should propagate")
	}
}

// —— F3：Compare / WhoAmI / PasswordModify（离线可测的门禁与请求构造） ——

func TestComparePolicyGates(t *testing.T) {
	ctx := context.Background()

	// 未知连接拒绝、不发审计
	svc, recs := newAuditService()
	if _, err := svc.Compare(ctx, LDAPCompareRequest{ConnectionID: "missing", DN: "cn=x", Attribute: "cn", Value: "y"}); err == nil ||
		!strings.Contains(err.Error(), "not connected") {
		t.Fatalf("unknown conn compare err = %v", err)
	}
	if len(*recs) != 0 {
		t.Errorf("no audit expected for unknown connection, got %+v", *recs)
	}

	connectProfile(t, svc, "c1", nil)
	// 空 DN / 空属性
	if _, err := svc.Compare(ctx, LDAPCompareRequest{ConnectionID: "c1", DN: " ", Attribute: "cn", Value: "y"}); err == nil ||
		err.Error() != "dn is required" {
		t.Errorf("empty dn err = %v", err)
	}
	if _, err := svc.Compare(ctx, LDAPCompareRequest{ConnectionID: "c1", DN: "cn=x", Attribute: " ", Value: "y"}); err == nil ||
		err.Error() != "attribute is required" {
		t.Errorf("empty attribute err = %v", err)
	}

	// 读白名单拒绝（读路径）→ read-policy/denied 审计
	whitelisted, whitelistedRecs := newAuditService()
	connectProfile(t, whitelisted, "c2", map[string]any{"allowed_base_dns": "dc=example,dc=com"})
	_, err := whitelisted.Compare(ctx, LDAPCompareRequest{ConnectionID: "c2", DN: "cn=x,dc=outside,dc=com", Attribute: "cn", Value: "y"})
	if err == nil || !strings.Contains(err.Error(), "outside allowed base DNs") {
		t.Fatalf("out-of-whitelist compare err = %v", err)
	}
	if recs := *whitelistedRecs; len(recs) != 1 || recs[0].Action != "read-policy" || recs[0].Result != "denied" {
		t.Errorf("compare audit = %+v", recs)
	}
}

func TestWhoAmIUnknownConnectionRejected(t *testing.T) {
	svc, recs := newAuditService()
	if _, err := svc.WhoAmI(context.Background(), LDAPWhoAmIRequest{ConnectionID: "missing"}); err == nil ||
		!strings.Contains(err.Error(), "not connected") {
		t.Fatalf("unknown conn whoami err = %v", err)
	}
	if len(*recs) != 0 {
		t.Errorf("whoami is a targetless read, no audit expected: %+v", *recs)
	}
}

func TestPasswordModifyPolicyGates(t *testing.T) {
	ctx := context.Background()

	// 1) read_only 拒绝（写路径门禁）→ write-policy/denied 审计
	ro, roRecs := newAuditService()
	connectProfile(t, ro, "ro", map[string]any{"read_only": true, "base_dn": "dc=example,dc=com"})
	_, err := ro.PasswordModify(ctx, LDAPPasswordModifyRequest{ConnectionID: "ro", DN: "cn=x,dc=example,dc=com", NewPassword: "n3w"})
	if err == nil || !strings.Contains(err.Error(), "read-only") {
		t.Fatalf("read-only passwdModify err = %v", err)
	}
	if recs := *roRecs; len(recs) != 1 || recs[0].Action != "write-policy" || recs[0].Result != "denied" {
		t.Errorf("read-only audit = %+v", recs)
	}

	// 2) 写白名单外（DN 越界）→ 拒绝；identity 缺省目标 = DN
	denied, deniedRecs := newAuditService()
	connectProfile(t, denied, "w1", map[string]any{"allowed_write_base_dns": "dc=a,dc=com"})
	_, err = denied.PasswordModify(ctx, LDAPPasswordModifyRequest{ConnectionID: "w1", DN: "cn=x,dc=outside,dc=com", NewPassword: "n3w"})
	if err == nil || !strings.Contains(err.Error(), "outside allowed write base DNs") {
		t.Fatalf("out-of-whitelist passwdModify err = %v", err)
	}
	if recs := *deniedRecs; len(recs) != 1 || recs[0].Target != "cn=x,dc=outside,dc=com" {
		t.Errorf("denied audit target = %+v", recs)
	}

	// 3) identity 非空时目标 DN = identity（越界 identity 以 identity 记审计）
	ident, identRecs := newAuditService()
	connectProfile(t, ident, "w2", map[string]any{"allowed_write_base_dns": "dc=a,dc=com"})
	_, err = ident.PasswordModify(ctx, LDAPPasswordModifyRequest{ConnectionID: "w2", DN: "cn=x,dc=a,dc=com",
		Identity: "cn=admin,dc=outside,dc=com", NewPassword: "n3w"})
	if err == nil || !strings.Contains(err.Error(), "outside allowed write base DNs") {
		t.Fatalf("identity outside whitelist err = %v", err)
	}
	if recs := *identRecs; len(recs) != 1 || recs[0].Target != "cn=admin,dc=outside,dc=com" {
		t.Errorf("identity-targeted audit = %+v", recs)
	}

	// 4) 空 DN / identity 携带裸控制字符（注入面）本地拒绝
	svc, _ := newAuditService()
	connectProfile(t, svc, "w3", nil)
	if _, err := svc.PasswordModify(ctx, LDAPPasswordModifyRequest{ConnectionID: "w3", DN: " "}); err == nil ||
		err.Error() != "dn is required" {
		t.Errorf("empty dn err = %v", err)
	}
	if _, err := svc.PasswordModify(ctx, LDAPPasswordModifyRequest{ConnectionID: "w3", DN: "cn=x", Identity: "cn=a\nb"}); err == nil ||
		!strings.Contains(err.Error(), "raw control characters") {
		t.Errorf("control-char identity err = %v", err)
	}

	// 审计不携带密码值（凭据红线）
	for _, rec := range append(*roRecs, append(*deniedRecs, *identRecs...)...) {
		if strings.Contains(rec.Detail, "n3w") {
			t.Errorf("audit must not carry password values: %+v", rec)
		}
	}
}

// —— F10：写路径审计携带 operation / durationMs ——

// read_only 拒绝路径（无需网络）即可验证写路径审计带上 operation 操作名。
func TestWriteAuditCarriesOperation(t *testing.T) {
	ctx := context.Background()

	ro, roRecs := newAuditService()
	connectProfile(t, ro, "ro", map[string]any{"read_only": true, "base_dn": "dc=example,dc=com"})
	if err := ro.AddEntry(ctx, LDAPAddEntryRequest{ConnectionID: "ro", DN: "cn=x,dc=example,dc=com",
		Attributes: map[string][]string{"cn": {"x"}}}); err == nil {
		t.Fatalf("read-only add should fail")
	}
	recs := *roRecs
	if len(recs) != 1 {
		t.Fatalf("audit records = %+v", recs)
	}
	if recs[0].Operation != "add" {
		t.Errorf("operation = %q, want add", recs[0].Operation)
	}
	if recs[0].DurationMs < 0 {
		t.Errorf("durationMs = %d, want >= 0", recs[0].DurationMs)
	}

	// 其余写路径的拒绝记录同样带操作名（modifyDn 走源 DN 门禁）。
	mdn, mdnRecs := newAuditService()
	connectProfile(t, mdn, "m", map[string]any{"allowed_write_base_dns": "dc=a,dc=com"})
	if err := mdn.ModifyDN(ctx, LDAPModifyDNRequest{ConnectionID: "m", DN: "cn=x,dc=z,dc=com", NewRDN: "cn=y"}); err == nil {
		t.Fatalf("out-of-whitelist modifyDn should fail")
	}
	if recs := *mdnRecs; len(recs) != 1 || recs[0].Operation != "modifyDn" {
		t.Errorf("modifyDn audit = %+v", recs)
	}

	pw, pwRecs := newAuditService()
	connectProfile(t, pw, "p", map[string]any{"read_only": true})
	if _, err := pw.PasswordModify(ctx, LDAPPasswordModifyRequest{ConnectionID: "p", DN: "cn=x"}); err == nil {
		t.Fatalf("read-only passwdModify should fail")
	}
	if recs := *pwRecs; len(recs) != 1 || recs[0].Operation != "passwdModify" {
		t.Errorf("passwdModify audit = %+v", recs)
	}
}

// 新字段 JSON 契约：camelCase 键名 operation/durationMs；零值 omitempty，
// 旧形状记录序列化不变（旧客户端/旧落盘无感）。
func TestAuditRecordJSONFields(t *testing.T) {
	raw, err := json.Marshal(AuditRecord{ConnectionID: "c", Action: "add-entry", Target: "cn=x",
		Result: "ok", Operation: "add", DurationMs: 12})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var generic map[string]any
	if err := json.Unmarshal(raw, &generic); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if generic["operation"] != "add" {
		t.Errorf("operation json = %v, want add: %s", generic["operation"], raw)
	}
	if _, ok := generic["durationMs"]; !ok {
		t.Errorf("durationMs json missing: %s", raw)
	}

	plain, err := json.Marshal(AuditRecord{ConnectionID: "c", Action: "add-entry", Target: "cn=x", Result: "ok"})
	if err != nil {
		t.Fatalf("marshal plain: %v", err)
	}
	if strings.Contains(string(plain), "operation") || strings.Contains(string(plain), "durationMs") {
		t.Errorf("zero-value record must omit new fields: %s", plain)
	}
}

// F11：SavePreset/ListPresets 透传保留 group 分组字段；upsert 清空 group 后
// 恢复未分组缺省（omitempty）。
func TestPresetsGroupRoundTrip(t *testing.T) {
	store := &memPresetStore{}
	svc := NewService()
	svc.Presets = store

	saved, err := svc.SavePreset(LDAPSearchPreset{Name: "ops-users", Group: "运维", BaseDN: "dc=example,dc=com"})
	if err != nil {
		t.Fatalf("save err = %v", err)
	}
	presets, err := svc.ListPresets()
	if err != nil || len(presets) != 1 {
		t.Fatalf("list = %+v, err = %v", presets, err)
	}
	if presets[0].Group != "运维" {
		t.Errorf("group after save = %q, want 运维", presets[0].Group)
	}

	// 全量 upsert：group 一并覆盖为空 → JSON omitempty 恢复未分组。
	raw, err := json.Marshal(LDAPSearchPreset{ID: saved.ID, Name: "ops-users-2"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(raw), "group") {
		t.Errorf("empty group must be omitted: %s", raw)
	}
	if _, err := svc.SavePreset(LDAPSearchPreset{ID: saved.ID, Name: "ops-users-2"}); err != nil {
		t.Fatalf("upsert err = %v", err)
	}
	presets, _ = svc.ListPresets()
	if len(presets) != 1 || presets[0].Group != "" {
		t.Errorf("after upsert presets = %+v, want group cleared", presets)
	}
}

func TestAggregateLimit(t *testing.T) {
	if got := aggregateLimit(0); got != defaultSearchAggregateLimit {
		t.Errorf("aggregateLimit(0) = %d, want %d", got, defaultSearchAggregateLimit)
	}
	if got := aggregateLimit(100); got != 100 {
		t.Errorf("aggregateLimit(100) = %d, want 100", got)
	}
	if got := aggregateLimit(-5); got != defaultSearchAggregateLimit {
		t.Errorf("aggregateLimit(-5) = %d, want %d", got, defaultSearchAggregateLimit)
	}
	if defaultSearchAggregateLimit != 500 {
		t.Errorf("defaultSearchAggregateLimit = %d, want 500 (§10)", defaultSearchAggregateLimit)
	}
}

func TestSchemaCacheNilSafe(t *testing.T) {
	// SchemaCache 为 nil 时 schemaCache() 兜底不 panic
	svc := NewService()
	svc.SchemaCache = nil
	if svc.schemaCache() == nil {
		t.Errorf("schemaCache() nil fallback failed")
	}
}

// --- 二进制值协议传输（读 base64 编码 / 写解码；对应前端 BinaryValueEditor）---

func TestLdapAttrNameKey(t *testing.T) {
	cases := map[string]string{
		"jpegPhoto":              "jpegphoto",
		"userCertificate;binary": "usercertificate",
		" objectGUID ":           "objectguid",
		"":                       "",
	}
	for name, want := range cases {
		if got := ldapAttrNameKey(name); got != want {
			t.Errorf("ldapAttrNameKey(%q) = %q, want %q", name, got, want)
		}
	}
}

func TestLdapBinaryValueAttributeNames(t *testing.T) {
	yes := []string{"objectGUID", "objectSid", "userPKCS12", "jpegPhoto", "thumbnailPhoto", "userCertificate;binary", "userSMIMECertificate"}
	no := []string{"cn", "unicodePwd", "userPassword", "sambaNTPassword", "description"}
	for _, name := range yes {
		if !ldapBinaryValueAttribute(name) {
			t.Errorf("ldapBinaryValueAttribute(%q) = false, want true", name)
		}
	}
	for _, name := range no {
		if ldapBinaryValueAttribute(name) {
			t.Errorf("ldapBinaryValueAttribute(%q) = true, want false", name)
		}
	}
}

func TestLdapBinaryValuePredicate(t *testing.T) {
	svc := NewService()
	connectProfile(t, svc, "binconn", map[string]any{"url": "ldap://127.0.0.1:1"})

	// schema 未加载：仅名字绑定命中；密码类永远排除。
	pred := svc.ldapBinaryValuePredicate("binconn")
	if !pred("jpegPhoto") || !pred("objectguid") {
		t.Errorf("name-bound binary attrs must match without schema")
	}
	if pred("cn") {
		t.Errorf("cn must not be binary without schema syntax")
	}

	// schema 缓存命中 octetString 语法 → 按语法判定；密码名排除优先。
	svc.SchemaCache.Put("binconn", LDAPSchemaMetadata{AttributeTypes: []LDAPSchemaAttributeType{
		{OID: "1.2.3", Name: "msExchSafeSendersHash", Syntax: "1.3.6.1.4.1.1466.115.121.1.40"},
		{OID: "1.2.4", Name: "unicodePwd", Syntax: "1.3.6.1.4.1.1466.115.121.1.40"},
		{OID: "1.2.5", Name: "cn", Syntax: "1.3.6.1.4.1.1466.115.121.1.15"},
	}})
	pred = svc.ldapBinaryValuePredicate("binconn")
	if !pred("msExchSafeSendersHash") {
		t.Errorf("octetString syntax attr must be binary via schema")
	}
	if pred("unicodepwd") {
		t.Errorf("password-bound names must win over binary syntax")
	}
	if pred("cn") {
		t.Errorf("cn (Directory String) must not be binary")
	}
}

func TestLdapEntryToTypeBinaryTransport(t *testing.T) {
	rawBinary := []byte{0x01, 0x02, 0xff, 0xfe, 0x00, 0x7f} // 非 UTF-8 的二进制哈希
	rawText := []byte("plain-text")                         // 合法 UTF-8 文本
	isBinary := func(name string) bool { return name == "Hash" }
	entry := &ldap.Entry{
		DN: "cn=a,dc=x",
		Attributes: []*ldap.EntryAttribute{
			{Name: "Hash", ByteValues: [][]byte{rawBinary}},
			{Name: "cn", ByteValues: [][]byte{rawText}},
			{Name: "weird", ByteValues: [][]byte{rawBinary}},
		},
	}
	converted := ldapEntryToType(entry, isBinary)
	// 二进制属性：base64 保真（前端按 base64 解释）。
	if got := converted.Attributes["Hash"][0]; got != base64.StdEncoding.EncodeToString(rawBinary) {
		t.Errorf("binary attr value = %q, want base64 of raw bytes", got)
	}
	// 普通属性合法 UTF-8：原样。
	if got := converted.Attributes["cn"][0]; got != "plain-text" {
		t.Errorf("text attr value = %q, want passthrough", got)
	}
	// 普通属性非法 UTF-8：base64 兜底（JSON 无法保真传输该字节）。
	if got := converted.Attributes["weird"][0]; got != base64.StdEncoding.EncodeToString(rawBinary) {
		t.Errorf("invalid-utf8 fallback = %q, want base64", got)
	}
}

func TestDecodeBinaryProtocolValues(t *testing.T) {
	encoded := base64.StdEncoding.EncodeToString([]byte{0xde, 0xad, 0xbe, 0xef})
	got := decodeBinaryProtocolValues([]string{encoded, "  " + encoded + " ", "not!!base64", ""})
	wantPlain := string([]byte{0xde, 0xad, 0xbe, 0xef})
	if got[0] != wantPlain || got[1] != wantPlain {
		t.Errorf("valid base64 must decode to raw bytes, got %q / %q", got[0], got[1])
	}
	if got[2] != "not!!base64" {
		t.Errorf("invalid base64 must pass through, got %q", got[2])
	}
	if got[3] != "" {
		t.Errorf("empty must pass through, got %q", got[3])
	}
}
