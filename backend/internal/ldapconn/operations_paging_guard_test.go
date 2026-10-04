package ldapconn

// operations_paging_guard_test.go：审查 M2 空页护栏的回归测试。真 LDAP 容器
// 不可进单测（仓库约定见 dedicated_conn_test.go），这里用 net.Pipe + asn1-ber
// 手搭最小假 LDAP 服务器：只应答 Search（SearchResultEntry/ResultDone +
// RFC 2696 分页控件），足以驱动 pagedSearchEntries 的全部循环形态：
//   - 同 cookie 空页 → 即时终止（truncated=false）；
//   - cookie 持续变化的连续空页 → maxPagedEmptyPages 截断 + 放弃请求；
//   - 正常翻页（有条目 → 空 cookie 结束）→ 全量收集。

import (
	"fmt"
	"net"
	"sync/atomic"
	"testing"
	"time"

	ber "github.com/go-asn1-ber/asn1-ber"
	ldap "github.com/go-ldap/ldap/v3"
)

// fakeSearchEnvelope 组一帧 LDAPMessage（envelope + protocolOp + 可选 controls）。
func fakeSearchEnvelope(messageID int64, protocolOp *ber.Packet, controls *ber.Packet) *ber.Packet {
	packet := ber.Encode(ber.ClassUniversal, ber.TypeConstructed, ber.TagSequence, nil, "LDAP Message")
	packet.AppendChild(ber.NewInteger(ber.ClassUniversal, ber.TypePrimitive, ber.TagInteger, messageID, "MessageID"))
	packet.AppendChild(protocolOp)
	if controls != nil {
		packet.AppendChild(controls)
	}
	return packet
}

// fakeSearchEntry 组一条 SearchResultEntry（仅 DN，无属性——客户端只取 DN 进本测试断言）。
func fakeSearchEntry(messageID int64, dn string) *ber.Packet {
	entry := ber.Encode(ber.ClassApplication, ber.TypeConstructed, ldap.ApplicationSearchResultEntry, nil, "Search Result Entry")
	entry.AppendChild(ber.NewString(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, dn, "Object Name"))
	attrs := ber.Encode(ber.ClassUniversal, ber.TypeConstructed, ber.TagSequence, nil, "Attributes")
	entry.AppendChild(attrs)
	return fakeSearchEnvelope(messageID, entry, nil)
}

// fakeSearchDone 组 SearchResultDone（success），withControl 时附带携带 cookie
// 的 RFC 2696 分页控件（cookie 为空表示翻页结束，走 received==nil/空 cookie 分支）。
func fakeSearchDone(messageID int64, cookie []byte) *ber.Packet {
	done := ber.Encode(ber.ClassApplication, ber.TypeConstructed, ldap.ApplicationSearchResultDone, nil, "Search Result Done")
	done.AppendChild(ber.NewInteger(ber.ClassUniversal, ber.TypePrimitive, ber.TagEnumerated, 0, "Result Code (success)"))
	done.AppendChild(ber.NewString(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, "", "Matched DN"))
	done.AppendChild(ber.NewString(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, "", "Diagnostic Message"))
	var controls *ber.Packet
	if cookie != nil {
		control := ldap.NewControlPaging(0)
		control.Cookie = cookie
		controls = ber.Encode(ber.ClassContext, ber.TypeConstructed, 0, nil, "Controls")
		controls.AppendChild(control.Encode())
	}
	return fakeSearchEnvelope(messageID, done, controls)
}

// serveFakePagingLDAP 在 pipe 的 server 侧循环应答 Search：cookieFor/entriesFor
// 按请求序号（0 起）给出当页 cookie 与 DN 列表；返回请求计数指针与收尾通道。
func serveFakePagingLDAP(t *testing.T, conn net.Conn, cookieFor func(seq int) []byte, entriesFor func(seq int) []string) (*int64, <-chan struct{}) {
	t.Helper()
	var requests int64
	served := make(chan struct{})
	go func() {
		defer close(served)
		for {
			packet, err := ber.ReadPacket(conn)
			if err != nil {
				return
			}
			var messageID int64
			switch value := packet.Children[0].Value.(type) {
			case int64:
				messageID = value
			case uint64:
				messageID = int64(value)
			default:
				return
			}
			seq := int(atomic.AddInt64(&requests, 1)) - 1
			for _, dn := range entriesFor(seq) {
				if _, err := conn.Write(fakeSearchEntry(messageID, dn).Bytes()); err != nil {
					return
				}
			}
			if _, err := conn.Write(fakeSearchDone(messageID, cookieFor(seq)).Bytes()); err != nil {
				return
			}
		}
	}()
	return &requests, served
}

// newPipedConn 建一根 pipe 并返回客户端 go-ldap Conn（server 端由调用方接管）。
func newPipedConn(t *testing.T) (*ldap.Conn, net.Conn) {
	t.Helper()
	client, server := net.Pipe()
	t.Cleanup(func() { _ = client.Close(); _ = server.Close() })
	conn := ldap.NewConn(client, false)
	conn.Start()
	conn.SetTimeout(10 * time.Second)
	t.Cleanup(func() { _ = conn.Close() })
	return conn, server
}

func testPagedSearchRequest() *ldap.SearchRequest {
	return ldap.NewSearchRequest("dc=test", ldap.ScopeWholeSubtree, ldap.NeverDerefAliases, 0, 0, false, "(objectClass=*)", nil, nil)
}

func TestPagedSearchEntriesStallSameCookieTerminates(t *testing.T) {
	conn, server := newPipedConn(t)
	requests, served := serveFakePagingLDAP(t, server,
		func(int) []byte { return []byte("stall-cookie") },
		func(int) []string { return nil },
	)

	entries, referrals, truncated, sortResult, err := pagedSearchEntries(conn, testPagedSearchRequest(), 500, 500)
	if err != nil {
		t.Fatalf("pagedSearchEntries returned error: %v", err)
	}
	if truncated || sortResult != 0 || len(entries) != 0 || len(referrals) != 0 {
		t.Errorf("stall guard should end cleanly: entries=%d truncated=%v sort=%d referrals=%d", len(entries), truncated, sortResult, len(referrals))
	}
	// 第一页（cookie≠nil 上页）继续，第二页同 cookie 即终止。
	if got := atomic.LoadInt64(requests); got != 2 {
		t.Errorf("roundtrips = %d, want 2 (second same-cookie empty page must stop the loop)", got)
	}
	_ = served
}

func TestPagedSearchEntriesCyclingEmptyCookiesTruncated(t *testing.T) {
	conn, server := newPipedConn(t)
	requests, served := serveFakePagingLDAP(t, server,
		func(seq int) []byte { return []byte(fmt.Sprintf("cycling-%d", seq)) },
		func(int) []string { return nil },
	)

	entries, _, truncated, _, err := pagedSearchEntries(conn, testPagedSearchRequest(), 500, 500)
	if err != nil {
		t.Fatalf("pagedSearchEntries returned error: %v", err)
	}
	if !truncated || len(entries) != 0 {
		t.Errorf("cycling empty cookies must end truncated with no entries: entries=%d truncated=%v", len(entries), truncated)
	}
	// 64 个空页 + 1 次放弃请求；断言下界即可（放弃是尽力而为，不计其响应）。
	if got := atomic.LoadInt64(requests); got < maxPagedEmptyPages+1 {
		t.Errorf("roundtrips = %d, want >= %d (empty-page pages + abandon)", got, maxPagedEmptyPages+1)
	}
	select {
	case <-served:
	default:
	}
}

func TestPagedSearchEntriesHappyPathCollectsPages(t *testing.T) {
	conn, server := newPipedConn(t)
	requests, _ := serveFakePagingLDAP(t, server,
		func(seq int) []byte {
			if seq == 0 {
				return []byte("page-1")
			}
			return nil // 空 cookie：翻页结束（received==nil/空 cookie 分支）
		},
		func(seq int) []string {
			if seq == 0 {
				return []string{"cn=a", "cn=b"}
			}
			return []string{"cn=c"}
		},
	)

	entries, _, truncated, sortResult, err := pagedSearchEntries(conn, testPagedSearchRequest(), 500, 500)
	if err != nil {
		t.Fatalf("pagedSearchEntries returned error: %v", err)
	}
	if truncated || sortResult != 0 || len(entries) != 3 {
		t.Fatalf("happy path = entries %d truncated %v sort %d, want 3/false/0", len(entries), truncated, sortResult)
	}
	for i, want := range []string{"cn=a", "cn=b", "cn=c"} {
		if entries[i].DN != want {
			t.Errorf("entries[%d].DN = %q, want %q", i, entries[i].DN, want)
		}
	}
	if got := atomic.LoadInt64(requests); got != 2 {
		t.Errorf("roundtrips = %d, want 2", got)
	}
}
