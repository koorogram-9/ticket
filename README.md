# 공연 모아보기 (KOPIS 실시간 연동)

공연예술통합전산망(KOPIS) 공연 정보를 그때그때 불러와 종류별, 예매처별로 보여 주는 앱이에요.

## 구조

- `public/index.html` : 화면 (브라우저에서 실행)
- `api/shows.js` : KOPIS를 대신 호출하는 서버리스 함수 (인증키는 여기서만 사용)
- `package.json` : Node 18 이상 지정

화면이 `/api/shows`를 부르고, 함수가 KOPIS에서 목록과 예매처 정보를 받아 돌려줘요.
인증키가 브라우저에 노출되지 않게 하려고 이렇게 나눴어요.

## 1단계. KOPIS 인증키 받기

1. KOPIS(kopis.or.kr)에 회원가입하고 로그인해요.
2. 오픈API 메뉴에서 이용 신청을 하고 서비스키를 발급받아요. 승인에 시간이 걸릴 수 있어요.
3. 같은 메뉴의 API 문서에서 아래를 꼭 확인하세요.
   - 공연 목록 조회의 요청 변수와 장르 코드 (`index.html`의 `CATS` 값과 맞는지)
   - 조회 기간 제한 (화면은 30일 단위로 조회해요)
   - 공연 상세 조회에 예매처 정보가 들어 있는지 (`relates`)
   - 하루 호출 한도

## 2단계. Vercel에 배포하기 (무료 플랜으로 시작 가능)

### 방법 A. 명령어로 배포

```bash
npm i -g vercel
cd show-board-app
vercel                      # 처음 실행하면 로그인과 프로젝트 설정을 물어요 (대부분 엔터)
vercel env add KOPIS_KEY    # 발급받은 서비스키 붙여넣기 (Production 선택)
vercel --prod               # 실제 주소로 배포
```

### 방법 B. GitHub로 배포

1. 이 폴더를 GitHub 저장소에 올려요. (인증키는 올리지 마세요)
2. vercel.com에서 저장소를 Import해요.
3. Settings > Environment Variables에 `KOPIS_KEY`를 추가해요.
4. Deploy를 누르면 끝이에요.

배포가 끝나면 `https://프로젝트이름.vercel.app` 주소가 생겨요. 휴대폰 홈 화면에 추가해 두면 편해요.

## 내 컴퓨터에서 먼저 테스트하기

```bash
cd show-board-app
echo "KOPIS_KEY=발급받은키" > .env.local
vercel dev
```

`http://localhost:3000` 에서 확인해요. `.env.local`은 GitHub에 올리지 마세요.

## 자주 만나는 문제

- 화면에 "KOPIS_KEY 환경변수가 설정되지 않았어요"가 나와요: 환경변수를 추가한 뒤 다시 배포해야 반영돼요.
- 목록이 비어 있어요: 장르 코드나 기간이 맞는지, 인증키가 승인되었는지 확인해요.
- 예매처 버튼이 안 나와요: 공연 상세 응답에 예매처 정보가 없는 경우예요. 호출량을 아끼려고 앞쪽 24개 공연만 상세 조회해요 (`api/shows.js`의 `DETAIL_LIMIT`).
- KOPIS 호출이 실패해요: `api/shows.js`의 `BASE` 주소 (`http`/`https`)를 KOPIS 문서와 맞춰 보세요. 환경변수 `KOPIS_BASE`로 바꿀 수 있어요.

## 알아 둘 점

- KOPIS는 공연 정보 서비스라서 예매 오픈일 같은 항목은 없을 수 있어요. 오픈일은 예매처 링크에서 확인하세요.
- 서버 응답은 1시간 동안 캐시해서 호출량을 줄여요.
- 인증키는 `index.html`이나 GitHub에 절대 넣지 마세요.
