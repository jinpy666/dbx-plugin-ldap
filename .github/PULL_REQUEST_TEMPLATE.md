## Agent handoff

- Task ID:
- Stage: `contract` / `implementation` / `review` / `integration`
- Base SHA:
- Allowed paths respected: yes / no
- Depends on PR:

## Verification

- [ ] repository and connection-form validation
- [ ] script unit tests
- [ ] frontend typecheck/test/build
- [ ] `cd backend && gofmt -l main.go internal`
- [ ] `cd backend && go vet ./... && go test ./...`
- [ ] LDAP plain/TLS/ldapi container smoke as applicable

## Review notes

- Changed files:
- Risks or known limitations:
- Follow-up task:
- Only local ephemeral directory/container credentials used: yes

