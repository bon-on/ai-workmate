# n8n Periodic Setup

이 저장소는 이미 텔레그램 브리지용 구조를 갖고 있지만, 주기 실행 자체는 외부 스케줄러가 맡아야 합니다.
가장 단순한 연결 방식은 n8n에서 이 워크스페이스의 로컬 스크립트를 정기적으로 실행하는 것입니다.

## 권장 흐름

1. `Cron` 노드로 실행 주기를 정합니다.
2. `Execute Command` 노드에서 아래 명령을 실행합니다.

```bash
scripts/generate-periodic-message.sh
```

3. 명령 실행 결과로 출력되는 파일 경로를 다음 단계에서 읽습니다.
4. 두 번째 `Execute Command` 노드에서 아래 명령으로 텔레그램 전송을 붙입니다.

```bash
npm run telegram:send -- --file out/periodic-message.txt
```

## 기본 산출물

- 프롬프트: `prompts/periodic-message-prompt.txt`
- 결과 파일: `out/periodic-message.txt`
- 전송 스크립트: `src/telegram-send.js`

## 프롬프트 교체

다른 주제나 보고서 형식이 필요하면 프롬프트 파일만 바꾸면 됩니다.

예시:

```bash
scripts/generate-periodic-message.sh \
  prompts/periodic-message-prompt.txt \
  out/morning-brief.txt
```

## 주의

- 이 스크립트는 `codex` CLI가 설치되어 있고 인증돼 있다는 전제입니다.
- 스크립트는 외부 전송을 하지 않고, 워크스페이스 안에 텍스트 파일만 생성합니다.
- 텔레그램 전송은 `.env`의 `TELEGRAM_BOT_TOKEN`을 재사용합니다.
- 전송 대상 채팅은 `DEFAULT_TELEGRAM_TARGET_CHAT_ID`가 있으면 그 값을 쓰고, 없으면 `ALLOWED_CHAT_IDS`의 첫 번째 값을 씁니다.
