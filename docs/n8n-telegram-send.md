# n8n Telegram Send

이 저장소에는 n8n이 로컬 명령으로 텔레그램 메시지를 보낼 수 있는 CLI가 포함돼 있습니다.

기본 대상 채팅은 `DEFAULT_TELEGRAM_TARGET_CHAT_ID`, 없으면 `ALLOWED_CHAT_IDS`의 첫 값입니다.
더 명시적으로 고정하려면 `.env`에 아래 값을 넣으면 됩니다.

```bash
DEFAULT_TELEGRAM_TARGET_CHAT_ID=123456789
```

## 가장 단순한 n8n 구성

1. `Manual Trigger` 또는 `Cron` 노드를 둡니다.
2. `Execute Command` 노드에서 아래 명령을 실행합니다.

```bash
npm run telegram:send -- --text "n8n test message"
```

3. 파일 내용 전송이 필요하면 `--file`을 사용합니다.

```bash
npm run telegram:send -- --file out/periodic-message.txt
```

4. 이전 노드에서 만든 문자열을 파이프로 넘기려면 `--stdin`을 씁니다.

```bash
printf '%s' "{{$json.message}}" | node src/telegram-send.js --stdin
```

## 동작 방식

- 토큰은 워크스페이스의 `.env`에서 읽습니다.
- 채팅 ID는 `--chat-id`, `DEFAULT_TELEGRAM_TARGET_CHAT_ID`, `ALLOWED_CHAT_IDS` 순서로 결정됩니다.
- 결과는 JSON으로 출력됩니다.

예시:

```json
{
  "ok": true,
  "chatId": "123456789",
  "messageId": 42
}
```
