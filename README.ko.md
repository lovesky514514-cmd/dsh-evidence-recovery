<h1 align="center">SKY Evidence Recovery</h1>

<p align="center"><strong>Durable evidence-backed recovery for opt-in DeepSeek Harness tools</strong></p>

<p align="center">
  <a href="docs/RELEASE_NOTES.md"><img alt="0.1.3-beta.4 candidate" src="https://img.shields.io/badge/candidate-0.1.3--beta.4-276DC3?style=flat-square"></a>
  <img alt="Public Beta" src="https://img.shields.io/badge/status-public%20beta-F59E0B?style=flat-square">
  <img alt="Windows 11 validated" src="https://img.shields.io/badge/tested-Windows%2011-1482BA?style=flat-square">
  <a href="LICENSE"><img alt="Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-2E7D32?style=flat-square"></a>
  <img alt="Node.js 24.9+" src="https://img.shields.io/badge/Node.js-%E2%89%A524.9.0-417E38?style=flat-square">
</p>

<p align="center">
  <a href="README.en.md">English</a> ·
  <a href="README.md">简体中文</a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.ja.md">日本語</a>
</p>

**DeepSeek Harness(DSH)** 도구를 위한 경량 실행 보호 플러그인입니다. 보호 대상 도구를 호출하기 **전에** 작업 식별 정보를 영구 기록합니다. 응답 손실·시간 초과·예외로 실행 결과가 불확실한 경우 동일 작업의 무분별한 재실행을 차단하고, 독립적인 결과 조회와 운영자 확인을 통해 다음 작업을 결정합니다.

**Exactly-once 실행은 보장하지 않습니다.** `rules`에 명시된 도구만 보호하며, 기본 설정인 `rules: []`는 어떤 도구도 보호하지 않습니다.

## 빠른 시작

DSH Web의 설정 → SKY Evidence Recovery에서 보호 상태와 확인 대기 기록을 보고 오프라인 조정용 증거를 작성할 수 있습니다.

1. 같은 버전의 소스 ZIP을 풀고 해당 디렉터리에서 `dsh plugin --profile sky-evidence-smoke add "file:$($PWD.Path)"`를 실행합니다.
2. [보호 규칙을 설정](#설치-및-테스트)하고 시작한 뒤 `sky_recovery_health`에서 잠금, 보호 대상 도구, `invalidRules: []`를 확인합니다.
3. `SKY_EXECUTION_UNKNOWN`이 발생하면 운영자 터미널에서 `node admin.js list --pending --data-dir $ledgerDir`를 실행합니다. 이어서 [기록 조회, 독립적인 검증, 조정 미리 보기](README.md#操作者恢复)를 진행합니다.

## 실제 DSH 설치 및 사용 검증 (0.1.3-beta.4)

이번 빌드는 모의 호스트만 사용한 테스트가 아니라, 실제 실행 중인 **DSH Desktop/Web에 `file:` 방식으로 설치하고 로드**했습니다. `sky_recovery_health` 호출에서 `loaded: true`, `ledgerLocked: true`, `protectedTools: []`가 반환되었고, 데모 주문 도구는 `unprotected` 상태였습니다. 이는 기본 설정인 `rules: []`에서 정상입니다. **플러그인 설치만으로 도구 보호가 시작되지는 않습니다.**

사용자는 설치된 DSH에서 **도구 호출 11회, 저장된 데모 주문 5건, 중복 주문 0건**을 확인했다고 보고했습니다. 이는 사용자의 실제 사용 보고이며, 해당 11회에 대한 원본 호출 로그가 공개 증거로 별도 보관된 것은 아닙니다. **DSH 설치와 호출 경로는 실제**였지만, **주문은 모의 도구의 부작용**이며 실제 결제나 환불 검증이 아닙니다.

외부 Windows 검증 보고서 기준으로 단위 테스트 **57/57**, DSH ToolRuntime **89/89**, 모델 A–E **5/5**(실제 도구 호출 10회), 모의 업무 시나리오 **60/60**(시도 110회, 모의 부작용 60회, 중복 차단 50회), DSH Web 상태 패널이 검증되었습니다. [공개 증거](docs/Public_Evidence_0.1.3-beta.4.zip)는 개인정보를 제거한 필드 요약본이며 원본 로그가 아닙니다. R30 및 R16의 특정 검증은 아직 완료되지 않았습니다.

**운영자 도구 배포상의 제한:** `admin.js`는 **동일 버전의 전체 소스**에만 포함되며 npm/DSH 런타임 설치 패키지에는 포함되지 않습니다. 설치된 패키지 안에서 파일을 찾으면 오류가 발생할 수 있습니다. DSH를 중지한 뒤, 신뢰할 수 있는 별도 운영자 터미널에서 해당 버전의 전체 소스로 `node admin.js ...`를 실행해야 합니다. 패키지 제외만으로 권한 격리가 보장되지는 않습니다. 향후 별도 운영자 CLI 배포를 검토합니다.

## 주요 기능

- **영속 실행 원장:** 작업 식별자 해시, 인수 지문, 실행 시도와 상태를 저장하여 재시작 후에도 확인할 수 있습니다.
- **중복 실행 방지:** 확실히 성공한 작업은 `succeeded`, 결과가 불확실한 작업은 `unknown`으로 유지하고 재시도를 차단합니다.
- **오류 시 안전한 차단:** 원장이나 잠금이 손상되거나 이용할 수 없으면 보호 대상 호출을 거부합니다.
- **증거 기반 복구:** 신뢰할 수 있는 운영자가 외부 시스템에서 결과를 확인한 뒤 오프라인으로 대조합니다. 도구의 오류 코드만으로 미실행을 판정하지 않습니다.
- **상태 확인:** `sky_recovery_health`, `sky_recovery_status`로 플러그인 및 원장 상태를 확인합니다.

## 설치 및 테스트

DSH 0.2 사전 출시 계열(아래 검증 버전 참조) 및 Node.js ≥24.9.0이 필요합니다. 격리된 프로필에 설치합니다.

```powershell
dsh plugin --profile sky-evidence-smoke add "file:$($PWD.Path)"
```

설치 직후에는 `rules: []`이므로 보호가 활성화되지 않습니다. 실제 사용하려는 도구를 명시적으로 설정해야 합니다.

```yaml
- id: sky-evidence-recovery
  config:
    rules:
      - tool: sky_demo_create_order
        keyArg: requestId
```

예시에는 제공된 `sky-evidence-recovery/demo` 도구도 필요합니다. Windows에서 `启动DSH测试.cmd`를 실행하면 **격리된 설정 사전 검사**만 수행하며, Web은 기본적으로 시작하지 않습니다. 실행 후 `sky_recovery_health`를 직접 호출하여 `loaded=true`, `ledgerLocked=true`, `protectedTools`에 대상 도구가 포함되는지 확인하세요.

<details>
<summary><strong>기술 흐름도와 설계 설명 펼치기</strong></summary>

```mermaid
flowchart TD
    A[Agent invokes a tool] --> B{Protected by rules?}
    B -->|No| C[Normal DSH dispatch]
    B -->|Yes| D{Ledger healthy and lock owned?}
    D -->|No| E[Reject protected call]
    D -->|Yes| F{Existing identity state?}
    F -->|succeeded or unknown| G[Block duplicate execution]
    F -->|new| H[Persist execution claim]
    H --> I[Dispatch tool once]
    I --> J{Confirmed success?}
    J -->|Yes| K[Persist succeeded]
    J -->|No or uncertain| L[Keep unknown and block retry]
    L --> M[Independent readback + operator reconciliation]
    M --> N{Authoritative outcome?}
    N -->|Committed| K
    N -->|Proven not committed| O[Operator releases for a new attempt]
```

- 도구 본문 실행 전에 작업 식별 정보를 영구 기록합니다.
- 확정 성공만 `succeeded`로 처리하며, 결과가 불확실하면 `unknown` 상태를 유지합니다. 읽기 전용 조회가 잠금을 자동 해제하지는 않습니다.
- 신뢰할 수 있는 운영자가 별도의 근거로 실제 결과를 확인한 뒤 오프라인 대조를 수행합니다. 제출되지 않았고 지연 제출 가능성도 없을 때만 재실행을 허용합니다.
- 플러그인이 로드되지 않으면 자체적으로 보호할 수 없으므로, DSH 호스트에서 보호 대상 도구의 활성화를 별도로 통제해야 합니다.

</details>

## 검증 범위

`0.1.2` 검증 결과는 [문제 및 수정 기록](问题与修复记录.md)을 참조하세요. 아래 표는 첫 공개 버전 `0.1.1`에 해당하는 내부 후보 `0.1.4-beta.1`의 이전 검증 결과입니다.

| 항목 | 결과 |
|---|---|
| Windows `npm run check` | 46 PASS, 0 FAIL, 0 SKIP |
| Windows PowerShell 5.1 / CMD | 7 PASS |
| 실제 DSH ToolRuntime | 중복 제거 기준 91개 검증 PASS, R30 호환성 테스트 BLOCKED |
| 실제 Web 모델 A–E | 5개 시나리오 PASS, 실제 도구 호출 10회 |
| npm 패키지 사전 검사 | PASS, 런타임 파일 13개 |

R16의 실제 런타임 디스크 오류 주입, macOS/Linux, 다중 프로세스·다중 호스트, 실제 업무 시스템 및 갑작스러운 전원 차단은 검증하지 않았습니다. 수치는 외부 검증 보고서에 따른 것이며 모든 원본 세션은 공개되지 않습니다. [최종 검증 보고서](docs/FINAL_TEST_REPORT.md)(중국어) 참고.

## 보안 제한과 문서

Agent에 동일 시스템 계정의 임의 shell·파일 쓰기·플러그인 관리 권한을 부여하면 원장을 우회할 수 있습니다. 호스트의 플러그인 활성화 검사가 필요합니다. 지원 범위는 명시적으로 지정한 도구 및 단일 프로세스 로컬 원장입니다.

[보안 범위](docs/SECURITY.md) · [문제 및 수정 기록](问题与修复记录.md)(중국어) · [릴리스 노트](docs/RELEASE_NOTES.md) · [코드 규칙](DSH_PLUGIN_CODE_STANDARDS.md) · [Apache-2.0](LICENSE)

**안내:** DeepSeek가 공식 제공하거나 보증하는 플러그인이 아닌 독립 커뮤니티 프로젝트입니다.
