const MORNING_MARKER = "[AI_WORKMATE_MORNING_BRIEF_V1]";
const EVENING_MARKER = "[AI_WORKMATE_EVENING_BRIEF_V1]";
const WEEKLY_MARKER = "[AI_WORKMATE_WEEKLY_REVIEW_V1]";
const AI_TREND_MARKER = "[AI_WORKMATE_AI_TREND_BRIEF_V1]";
const DAILY_DISCOVERY_MARKER = "[AI_WORKMATE_DAILY_DISCOVERY_V1]";

export async function ensurePersonalBriefingSchedules({ schedules, config, now = new Date() }) {
  if (!config.personalBriefingsEnabled) return [];
  const chatId = config.defaultTelegramTargetChatId || config.allowedChatIds[0];
  const userId = config.allowedUserIds[0] || "system";
  if (!chatId) return [];
  for (const obsolete of schedules.list(chatId).filter((row) => row.prompt.includes(DAILY_DISCOVERY_MARKER))) {
    await schedules.remove({ chatId, id: obsolete.id });
  }
  const definitions = [
    { marker: MORNING_MARKER, hour: config.morningBriefHour, minute: config.morningBriefMinute, prompt: buildMorningBriefPrompt(config.personalLocation) },
    { marker: EVENING_MARKER, hour: config.eveningBriefHour, minute: config.eveningBriefMinute, prompt: buildEveningBriefPrompt(config.personalLocation) },
    { marker: WEEKLY_MARKER, hour: config.weeklyReviewHour, minute: config.weeklyReviewMinute, weekday: 0, prompt: buildWeeklyReviewPrompt(config.personalLocation) },
    { marker: AI_TREND_MARKER, hour: config.aiTrendBriefHour, minute: config.aiTrendBriefMinute, prompt: buildAiTrendBriefPrompt() },
  ];
  const created = [];
  for (const definition of definitions) {
    const existing = schedules.list(chatId).find((row) => row.prompt.includes(definition.marker));
    if (existing) {
      if (existing.prompt !== definition.prompt && schedules.updatePrompt) {
        await schedules.updatePrompt(existing.id, definition.prompt);
      }
      const scheduled = new Date(existing.nextRunAt);
      if ((scheduled.getHours() !== definition.hour || scheduled.getMinutes() !== definition.minute) && schedules.reschedule) {
        await schedules.reschedule(existing.id, nextLocalTime(now, definition.hour, definition.minute, definition.weekday));
      }
      continue;
    }
    const nextRunAt = nextLocalTime(now, definition.hour, definition.minute, definition.weekday);
    created.push(await schedules.add({
      chatId,
      userId,
      workspaceAlias: config.workspaces.defaultAlias,
      prompt: definition.prompt,
      nextRunAt,
      intervalMs: definition.weekday === undefined ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000,
      weekdaysOnly: false,
    }));
  }
  return created;
}

export function buildMorningBriefPrompt(location = "서울") {
  return `${MORNING_MARKER}
역할: 사용자가 아침에 1분 안에 오늘의 행동을 결정하도록 돕는 개인 비서입니다.
성공 기준: 오늘 일정과 날씨를 놓치지 않고, 최근 브리핑과 겹치지 않는 구체적인 행동만 남깁니다.

아래 출력 형식을 그대로 따르세요. Markdown 제목 기호(#), 표, 서론, 맺음말은 사용하지 마세요. 전체는 1,300자 이내로 제한하세요.

☀️ 모닝 브리핑 · M월 D일 요일

🌦 날씨
• 하늘: 현재 위치 '${location}'의 날씨 상태(맑음·흐림 등)
• 현재: N°C (체감 N°C)
• 최고/최저: N°C / N°C
• 강수 확률: N%
• 우산, 복장, 폭염·한파 등 실제로 필요한 외출 조언 한 줄

📅 일정
• 오늘 Apple Calendar 일정을 시간순으로 최대 3개
• 충돌이나 준비물이 있을 때만 한 줄 추가. 일정이 없으면 '오늘 등록된 일정 없음' 한 줄만 표시

🎯 오늘의 초점
• 오늘 일정이나 개인 inbox를 근거로 가장 중요한 결과 하나와 10분 안에 시작할 첫 행동을 한 줄로 표시. 근거가 없으면 이 블록 전체를 생략

💡 오늘의 추천
• 오늘 실행할 가치가 큰 행동 1~2개만 각각 한 줄로 제안
• AI 활용, IT·개발, 맥미니 활용, 생산성, 건강, 가족·지인에게 연락하기, 취미, 현재 위치 '${location}'를 출발점으로 한 맛집·산책·나들이·행사 등 어떤 분야도 가능합니다.
• 매번 모든 분야를 채우지 말고 그날 가치 있는 것만 자유롭게 고르세요. 부담이 적은 추천과 새로운 시도를 적절히 섞으세요.
• 평일에는 집·회사에서 바로 하거나 평소 생활 동선 안에서 10~30분이면 가능한 행동을 우선하세요. 별도 이동이 필요한 공원·맛집·전시·근교 나들이는 가끔만 제안하고, 당일 실행보다 주말 후보가 적절하면 '주말 후보'로 표시하세요.
• 장소·행사·영업 여부처럼 변할 수 있는 추천은 웹에서 확인하고 짧은 링크를 붙이세요. 예약·구매·설치는 직접 실행하지 마세요.

최근 추천 이력에 있는 행동과 의미상 비슷한 제안은 표현만 바꿔 반복하지 마세요. 걷기·책 읽기·사진 정리·안부 연락 같은 일반 추천은 같은 종류를 7일에 한 번 이하로 제한하세요. 모닝과 전날 이브닝의 추천도 겹치지 않아야 합니다.

시스템·서비스 상태, n8n 상태, 디스크, 외장 SSD, Telegram 연결, 웹 감시, 일반 AI·개발 뉴스는 포함하지 마세요. 정오의 AI 트렌드 및 이브닝 브리핑과 같은 설명을 반복하지 말고, 모닝에는 실행 가능한 짧은 행동만 제시하세요. 확인되지 않은 내용은 추측하지 마세요. 외부 상태는 변경하지 마세요. 완성 후 형식, 길이, 중복, 근거를 스스로 점검하고 최종 브리핑만 출력하세요.`;
}

export function buildEveningBriefPrompt(location = "서울") {
  return `${EVENING_MARKER}
역할: 사용자가 2분 안에 내일을 준비하고 새로운 선택지를 발견하도록 돕는 개인 비서입니다.
성공 기준: 기록이 없는 섹션은 줄이고, 내일 준비와 최근에 없던 추천을 우선합니다.

아래 출력 형식을 그대로 따르세요. Markdown 제목 기호(#), 표, 서론, 맺음말은 사용하지 마세요. 전체는 1,300자 이내로 제한하세요.

🌙 이브닝 브리핑 · M월 D일 요일

✅ 오늘 정리
• 완료한 일, 미완료 inbox, 새 아이디어 중 의미 있는 내용만 최대 3개. 아무 기록도 없으면 이 블록 전체를 생략

📈 Trading dry-run
• 이 시스템은 국내 주식 모의매매이며 손익 통화는 항상 원화(KRW)입니다.
• 변화가 있으면 당일 손익을 소수점 없이 반올림해 '당일 손익 -344원'처럼 표시하고 주문·포지션 변화를 한 줄로 요약하세요. '통화 단위 미제공'이라고 쓰지 마세요.
• 손익·주문·포지션 변화가 모두 0이면 '변화 없음'으로만 표시. 매매는 실행하지 마세요.

📅 내일 일정
• Apple Calendar 일정을 시간순으로 최대 3개
• 내일 날씨를 고려한 복장·우산, 충돌, 준비물, 출발 시간이 실제로 필요할 때만 한 줄 추가. 일정이 없으면 '내일 등록된 일정 없음' 한 줄만 표시

🧭 내일과 가까운 시일의 제안
• 서로 다른 분야에서 실행할 행동 2~3개. 미완료 일, 일정 준비, AI·IT·개발, 맥미니 활용, 생산성, 생활, 건강, 가족·지인, 취미, 책·영상·문화, 현재 위치 '${location}'를 출발점으로 한 맛집·산책·전시·축제·나들이 중 가치 있는 분야만 선택
• 실용적인 추천과 뜻밖의 발견을 섞되 매번 모든 분야를 억지로 채우지 않기
• 내일이 평일이면 집·회사 또는 평소 생활 동선 안에서 10~30분이면 가능한 행동을 우선하고, 멀리 이동하는 장소 추천은 가끔만 '주말 후보'로 분리
• 장소·행사·영업 여부·비용처럼 변할 수 있는 내용은 웹에서 확인하고 공식 출처 링크와 예상 시간·비용을 짧게 표시

💭 짧은 회고
• 최근 이브닝 브리핑 2건에 회고 질문이 없을 때만 구체적으로 답할 수 있는 질문 하나. 그 외에는 이 블록 생략

최근 추천 이력에 있는 행동과 의미상 비슷한 제안은 표현만 바꿔 반복하지 마세요. 걷기·책 읽기·사진 정리·안부 연락 같은 일반 추천은 같은 종류를 7일에 한 번 이하로 제한하세요. 당일 모닝 추천과도 겹치지 않아야 합니다. 주 2~3회는 일반적인 습관 조언 대신 구체적인 도구·콘텐츠·장소 중 하나를 발견 항목으로 제시하세요.

시스템·서비스 상태, n8n 상태, 디스크, SSD, Telegram 연결, 웹 감시와 일반 뉴스는 포함하지 마세요. 확인되지 않은 내용은 추측하지 마세요. 외부 상태는 변경하지 마세요. 완성 후 형식, 길이, 중복, 근거를 스스로 점검하고 최종 브리핑만 출력하세요.`;
}

export function buildWeeklyReviewPrompt(location = "서울") {
  return `${WEEKLY_MARKER}
지난 7일을 돌아보고 다음 주를 선택하는 주간 리뷰를 한국어로 작성하세요. inbox, 완료 기록, 일정과 trading dry-run을 근거로 사용하세요.

웹 검색이나 외부 도구는 사용하지 마세요. 제공된 로컬 컨텍스트만 근거로 작성하고, 현재 운영 여부 확인이 필요한 특정 행사·매장·상품은 추천하지 마세요.

아래 출력 형식을 그대로 따르세요. Markdown 제목 기호(#), 표, 서론, 맺음말은 사용하지 마세요. 전체는 1,800자 이내로 제한하세요.

🗓 주간 리뷰 · M월 D일

🏁 이번 주
• 완료한 일, 기억할 일, 의미 있는 변화 최대 4개

🔁 보이는 패턴
• 반복해서 미룬 일, 관심과 시간 사용, 잘된 습관을 합쳐 최대 3개. 근거 없는 심리 해석은 하지 않기

🎯 다음 주 핵심
• 실제로 달성 가능한 목표 3개. 각 목표의 첫 행동을 함께 표시

💡 다음 주 추천
• AI·IT·맥미니 활용, 생활, 건강, 가족·지인, 취미, 현재 위치 '${location}'를 출발점으로 한 외출 중 서로 다른 분야에서 3~5개
• 평일 추천은 집·회사·생활 동선에서 10~30분 이내로 실행 가능한 것을 우선하고, 공원·맛집·전시·근교처럼 별도 이동이 필요한 제안은 주말 항목으로 구분
• 외출은 특정 행사나 영업 정보를 단정하지 않고 활동 종류와 후보 지역 수준으로만 제안하기

🧹 덜어낼 것
• 하지 않아도 되는 일이나 습관이 명확할 때만 최대 2개. 없으면 이 블록 생략

시스템·서비스 상태, n8n 상태, 디스크, SSD, Telegram 연결, 웹 감시, 장애 목록과 Trading 결과는 포함하지 마세요. 확인되지 않은 내용은 추측하지 마세요. 외부 상태는 변경하지 마세요.`;
}

export function buildAiTrendBriefPrompt() {
  return `${AI_TREND_MARKER}
개발자가 3분 안에 읽고 판단할 수 있는 개인 개발 레이더를 한국어로 작성하세요. 최근 24시간을 우선하되 중요한 소식이 부족하면 최근 7일까지 확장하세요. 사용자는 Claude Code, Codex, Ollama, Node.js, Telegram 자동화와 항상 켜진 Mac mini를 활용하므로 실제 환경에 영향을 주는 변화에 우선순위를 두세요. 특정 회사나 제품에 치우치지 말고, 같은 회사·제품의 소식은 하루에 하나만 고르세요. 이미 보낸 항목 목록이 주어지면 그 사건과 후속 요약은 제외하세요.

공식 발표, 원문 논문, 공식 저장소 등 1차 출처를 웹에서 확인하세요. 검색은 서로 다른 주제로 최대 2회, 상세 페이지 열람은 최대 3개로 제한하세요. 모델/API, AI 개발 도구, 오픈소스, 연구, 보안·정책 중 현재 개발 환경이나 개인 프로젝트 방식에 영향을 줄 내용만 최대 2개 고르세요. 중요한 소식이 없으면 과거 소식을 반복하지 말고 '오늘은 확인할 만한 중요 변화 없음'이라고 짧게 작성하세요.

아래 출력 형식을 그대로 따르세요. Markdown 제목 기호(#), 별표 강조, 표, 인라인 코드, [제목](주소) 형태의 Markdown 링크, 서론과 맺음말은 사용하지 마세요. 전체는 2,200자 이내로 제한하세요.

🤖 AI 트렌드
🧭 개인 개발 레이더 · M월 D일

1️⃣ 짧은 제목 · 발표일
• 변화: 무엇이 발표되거나 바뀌었는지 한 문장
• 의미: 개발자에게 왜 중요한지 한 문장
• 해볼 것: 실제로 시험하거나 확인할 행동 한 문장
🔗 출처명: 원문 URL

같은 형식으로 1~2개를 작성하세요.

🧪 오늘의 15분 실험
• 가장 가치 있는 작은 실험 하나와 완료 기준을 한 문장으로 제안

기사 게시일과 실제 사건 날짜가 다르면 실제 사건 날짜를 우선 표시하세요. 광고성 발표와 확인되지 않은 소문은 제외하세요. URL은 원문 주소를 그대로 적고 링크 미리보기를 위한 긴 설명을 붙이지 마세요. 외부 상태를 변경하거나 가입·구매하지 마세요.`;
}

export function buildDailyDiscoveryPrompt(location = "서울") {
  return `${DAILY_DISCOVERY_MARKER}
사용자에게 오늘 새롭게 추천할 것 3개를 한국어로 작성하세요. 사용자는 IT 개발자이며 현재 위치의 기준점은 '${location}'입니다. 추천 장소를 이 행정구역 안으로 한정하라는 뜻은 아니며, 이 위치에서의 이동 거리와 접근성을 판단하는 출발점으로만 사용하세요.
추천 범주는 개발 도구·작은 프로젝트·학습, 동네/근교의 장소·전시·축제·산책, 책·영상·문화, 건강·생활 아이디어 중 매일 다양하게 섞으세요.
실행일이 평일이면 집·회사에서 바로 하거나 평소 생활 동선 안에서 10~30분이면 가능한 추천을 우선하세요. 먼 공원, 별도 목적지의 맛집·전시, 근교 나들이처럼 이동이 필요한 추천은 매일 넣지 말고 가끔만 제시하며, 당일보다 주말이 적절하면 '주말 후보'로 명확히 표시하세요. 주말에는 이동 추천 비중을 늘려도 됩니다.
현재 운영 여부, 행사 날짜, 위치, 비용처럼 변할 수 있는 정보는 웹에서 확인하고 공식 출처 링크를 붙이세요. 방문 추천은 이동 거리나 예상 소요 시간을 함께 적으세요.
각 추천마다 '추천 이유 / 오늘 할 수 있는 가장 작은 행동 / 필요한 시간·비용'을 포함하고, 예약·구매·설치·외부 상태 변경은 직접 실행하지 마세요.
억지로 사용자의 기존 시스템과 연결하지 말고, 실용적인 것과 뜻밖의 발견을 함께 제시하세요.`;
}

function nextLocalTime(now, hour, minute, weekday) {
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (weekday === undefined) {
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.toISOString();
  }
  let delta = (weekday - next.getDay() + 7) % 7;
  if (delta === 0 && next <= now) delta = 7;
  next.setDate(next.getDate() + delta);
  return next.toISOString();
}
