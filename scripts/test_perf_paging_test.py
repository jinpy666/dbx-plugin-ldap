"""Offline regression coverage for the disposable performance-paging harness."""

from __future__ import annotations

import unittest

from perf_paging_test import ENTRY_COUNT, PAGE_SIZE, PEOPLE, assert_page_sequence, expected_dns, fixture_ldif


class FakeClient:
    def __init__(self, pages: list[list[str]], *, cancel_success: bool = True):
        self.pages = pages
        self.cancel_success = cancel_success
        self.calls: list[tuple[str, dict]] = []
        self.next_index = 1

    def request(self, method: str, params: dict) -> dict:
        self.calls.append((method, params))
        if method == "ldap/search/start":
            return {"searchId": "test-search", "entries": self.entries(0), "hasMore": len(self.pages) > 1}
        if method == "ldap/search/next":
            index = self.next_index
            self.next_index += 1
            return {"entries": self.entries(index), "hasMore": index + 1 < len(self.pages)}
        if method == "ldap/search/cancel":
            return {"success": self.cancel_success}
        raise AssertionError(f"unexpected method {method}")

    def entries(self, index: int) -> list[dict[str, str]]:
        return [{"dn": dn} for dn in self.pages[index]]


def split_fixture() -> list[list[str]]:
    dns = sorted(expected_dns())
    return [dns[offset:offset + PAGE_SIZE] for offset in range(0, len(dns), PAGE_SIZE)]


class PagingHarnessTests(unittest.TestCase):
    def test_fixture_has_multiple_pages_and_no_embedded_credentials(self):
        ldif = fixture_ldif()
        self.assertEqual(len(expected_dns()), ENTRY_COUNT)
        self.assertGreater(ENTRY_COUNT, PAGE_SIZE)
        self.assertIn(f"dn: uid=page-000,{PEOPLE}", ldif)
        self.assertIn(f"dn: uid=page-{ENTRY_COUNT - 1:03d},{PEOPLE}", ldif)
        self.assertNotIn("LDAP_ADMIN_PASSWORD", ldif)

    def test_accepts_a_complete_exactly_once_sequence_and_cancels(self):
        client = FakeClient(split_fixture())
        assert_page_sequence(client, "connection", start_method="ldap/search/start",
                             next_method="ldap/search/next", cancel_method="ldap/search/cancel")
        self.assertEqual([call[0] for call in client.calls], [
            "ldap/search/start", "ldap/search/next", "ldap/search/next",
            "ldap/search/next", "ldap/search/next", "ldap/search/cancel",
        ])
        self.assertEqual(client.calls[0][1]["pageSize"], PAGE_SIZE)
        self.assertEqual(client.calls[-1][1]["searchId"], "test-search")

    def test_rejects_a_duplicate_across_pages_and_still_cancels(self):
        pages = split_fixture()
        pages[1][0] = pages[0][0]
        client = FakeClient(pages)
        with self.assertRaisesRegex(AssertionError, "duplicate DN across pages"):
            assert_page_sequence(client, "connection", start_method="ldap/search/start",
                                 next_method="ldap/search/next", cancel_method="ldap/search/cancel")
        self.assertEqual(client.calls[-1][0], "ldap/search/cancel")

    def test_rejects_an_omitted_dn(self):
        pages = split_fixture()
        pages[-1] = pages[-1][:-1]
        client = FakeClient(pages)
        with self.assertRaisesRegex(AssertionError, "missing="):
            assert_page_sequence(client, "connection", start_method="ldap/search/start",
                                 next_method="ldap/search/next", cancel_method="ldap/search/cancel")

    def test_rejects_non_boolean_has_more(self):
        class BadHasMore(FakeClient):
            def request(self, method: str, params: dict) -> dict:
                response = super().request(method, params)
                if method == "ldap/search/start":
                    response["hasMore"] = "true"
                return response

        client = BadHasMore(split_fixture())
        with self.assertRaisesRegex(AssertionError, "boolean hasMore"):
            assert_page_sequence(client, "connection", start_method="ldap/search/start",
                                 next_method="ldap/search/next", cancel_method="ldap/search/cancel")
        self.assertEqual(client.calls[-1][0], "ldap/search/cancel")


if __name__ == "__main__":
    unittest.main()
