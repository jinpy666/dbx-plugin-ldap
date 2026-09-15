package ldapconn

import "testing"

// 方言检测（阶段1）：RootDSE → dialect/vendor 摘要。
// 样例对齐各服务器的真实 RootDSE vendor 值：
//   - AD: vendorName "Microsoft Corporation."、supportedCapabilities 含
//     1.2.840.113556.1.4.800
//   - 389DS: vendorName "389 Project"、productName "389-Directory/1.4.x"
//   - FreeIPA: productName/vendorName 含 freeipa
//   - OpenLDAP: vendorName "OpenLDAP"（productName 形如 "OpenLDAP 2.6.7"）
func TestDetectLDAPDialect(t *testing.T) {
	adByCapability := LDAPEntry{Attributes: map[string][]string{
		"vendorName":            {"Microsoft Corporation."},
		"supportedCapabilities": {"1.2.840.113556.1.4.800", "1.2.840.113556.1.4.1851"},
	}}
	dialect, vendor, _ := detectLDAPDialect(adByCapability)
	if dialect != DialectAD || vendor != "Microsoft Corporation." {
		t.Errorf("AD by capability = %q/%q", dialect, vendor)
	}

	// 无能力属性时按 vendor 名兜底（部分代理/网关不透传 supportedCapabilities）
	adByVendor := LDAPEntry{Attributes: map[string][]string{"vendorName": {"Microsoft Corporation."}}}
	if dialect, _, _ = detectLDAPDialect(adByVendor); dialect != DialectAD {
		t.Errorf("AD by vendor = %q", dialect)
	}

	freeIPA := LDAPEntry{Attributes: map[string][]string{"productName": {"FreeIPA/4.9.12"}}}
	if dialect, _, _ = detectLDAPDialect(freeIPA); dialect != DialectFreeIPA {
		t.Errorf("FreeIPA = %q", dialect)
	}

	ds389 := LDAPEntry{Attributes: map[string][]string{
		"vendorName":  {"389 Project"},
		"productName": {"389-Directory/1.4.3.39 B2024.071.1350"},
	}}
	if dialect, vendor, productName := detectLDAPDialect(ds389); dialect != Dialect389DS || vendor != "389 Project" || productName == "" {
		t.Errorf("389DS = %q/%q/%q", dialect, vendor, productName)
	}

	redHat := LDAPEntry{Attributes: map[string][]string{"vendorName": {"Red Hat"}}}
	if dialect, _, _ = detectLDAPDialect(redHat); dialect != Dialect389DS {
		t.Errorf("Red Hat = %q", dialect)
	}

	openLDAP := LDAPEntry{Attributes: map[string][]string{"vendorName": {"OpenLDAP"}}}
	if dialect, _, _ = detectLDAPDialect(openLDAP); dialect != DialectOpenLDAP {
		t.Errorf("OpenLDAP = %q", dialect)
	}

	// 未知 vendor：通用 RFC 4511 兜底
	generic := LDAPEntry{Attributes: map[string][]string{"vendorName": {"Some Directory Server"}}}
	if dialect, _, _ = detectLDAPDialect(generic); dialect != DialectRFC4511 {
		t.Errorf("generic vendor = %q", dialect)
	}

	// 空 RootDSE（仅 subschemaSubentry）：仍归通用
	empty := LDAPEntry{Attributes: map[string][]string{"subschemaSubentry": {"cn=Subschema"}}}
	if dialect, _, _ = detectLDAPDialect(empty); dialect != DialectRFC4511 {
		t.Errorf("empty rootDSE = %q", dialect)
	}
}

func TestResolveSchemaAppliesDialect(t *testing.T) {
	rootDSE := LDAPEntry{Attributes: map[string][]string{
		"subschemaSubentry":     {"cn=Subschema"},
		"vendorName":            {"Microsoft Corporation."},
		"supportedCapabilities": {"1.2.840.113556.1.4.800"},
	}}
	metadata, err := ResolveSchema(Profile{}, rootDSE, sampleSubschemaEntry)
	if err != nil {
		t.Fatalf("ResolveSchema error = %v", err)
	}
	if metadata.Dialect != DialectAD {
		t.Errorf("dialect = %q, want ad", metadata.Dialect)
	}
	if metadata.VendorName != "Microsoft Corporation." {
		t.Errorf("vendorName = %q", metadata.VendorName)
	}
}

func TestApplyLDAPDialectMetadata(t *testing.T) {
	metadata := LDAPSchemaMetadata{SubschemaSubentry: "cn=Subschema"}
	applyLDAPDialectMetadata(&metadata, LDAPEntry{Attributes: map[string][]string{
		"vendorName":  {"389 Project"},
		"productName": {"389-Directory/1.4.3"},
	}})
	if metadata.Dialect != Dialect389DS || metadata.VendorName != "389 Project" {
		t.Errorf("apply = %+v", metadata)
	}
}
