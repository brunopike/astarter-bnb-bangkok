// Each public channel has the same permanent path in the eight interface languages.
export const seoLanguages={en:['en','en_US'],zh:['zh-CN','zh_CN'],ja:['ja','ja_JP'],ko:['ko','ko_KR'],vi:['vi','vi_VN'],es:['es','es_ES'],fr:['fr','fr_FR'],ru:['ru','ru_RU']};
export function seoLanguage(value){
 const key=String(value||'en').toLowerCase().split('-')[0];
 return Object.hasOwn(seoLanguages,key)?key:'en';
}
export const previews={
 zh:{lite:["Lite 交易台", "在 Lite 工作台查看实时信号与行情依据，选择标的并体验模拟交易。"]},
 en:{lite:["Lite Trading Desk", "Review live market signals and their evidence, then try a paper trade in the Lite workspace."]},
 ja:{
  lite:["Lite 取引デスク", "Lite で最新の市場シグナルと判断根拠を確認し、銘柄を選んで模擬取引を試せます。"],
  brain:['Deep Brain','Cortexa のリサーチグラフで市場観測の根拠と調査ノートを確認できます。'],workbench:['LensWave','追跡中の資産について、市場データ、検証結果、テクニカル分析を確認できます。'],
  strategies:['戦略エージェント','取引戦略の仕組み、対象市場、リスク設定を比較できます。'],signals:['市場シグナル','資産や状態で市場シグナルを絞り込み、根拠を確認できます。'],opportunities:['市場機会','市場で観測された機会と、その調査内容を確認できます。'],
  markets:['市場データ','暗号資産と伝統資産の価格や取引動向を確認できます。'],tracking:['オンチェーン追跡','オンチェーン活動と取引所の資金フローを確認できます。'],intelligence:['ニュースと市場心理','経済カレンダーと市場ニュースを配信元や公開日時とともに確認できます。'],
  social:['ソーシャル動向','注目の投稿、話題の推移、トレーダーランキングを確認できます。'],derivatives:['デリバティブと清算','資産や取引所ごとの資金調達率と清算状況を確認できます。'],etf:['ETF 資金フロー','ビットコイン・イーサリアム ETF の資金フローをファンドごとに比較できます。']},
 ko:{
  lite:["Lite 트레이딩 데스크", "Lite에서 실시간 시장 신호와 근거를 확인하고 종목을 골라 모의 거래를 체험하세요."],
  brain:['Deep Brain','Cortexa 리서치 그래프에서 시장 관측의 근거와 연구 노트를 살펴보세요.'],workbench:['LensWave','관심 자산의 시세, 근거 검증 결과와 기술적 관측을 확인하세요.'],
  strategies:['전략 에이전트','거래 전략의 작동 방식, 지원 시장과 위험 설정을 비교하세요.'],signals:['시장 신호','자산과 상태별로 시장 신호를 살펴보고 관련 근거를 확인하세요.'],opportunities:['시장 기회','관측된 시장 기회와 관련 연구 내용을 확인하세요.'],
  markets:['시장 데이터','암호화폐와 전통 자산의 가격 및 시장 동향을 확인하세요.'],tracking:['온체인 추적','온체인 활동과 거래소 자금 흐름을 살펴보세요.'],intelligence:['뉴스와 시장 심리','시장 속보와 경제 일정을 출처 및 게시 시간과 함께 확인하세요.'],
  social:['소셜 동향','선별된 시장 논평, 주제별 활동과 트레이더 순위를 확인하세요.'],derivatives:['파생상품 및 청산','자산과 거래소별 펀딩비와 청산 동향을 비교하세요.'],etf:['ETF 자금 흐름','비트코인과 이더리움 ETF의 펀드별 자금 흐름을 확인하세요.']},
 vi:{
  lite:["Bàn giao dịch Lite", "Xem tín hiệu thị trường trực tiếp cùng dữ liệu làm căn cứ, chọn tài sản và thử giao dịch mô phỏng trong Lite."],
  brain:['Deep Brain','Khám phá đồ thị nghiên cứu Cortexa, bằng chứng và ghi chú cho từng nhận định thị trường.'],workbench:['LensWave','Theo dõi dữ liệu thị trường, kết quả kiểm chứng và quan sát kỹ thuật của từng tài sản.'],
  strategies:['Agent chiến lược','So sánh cơ chế của từng chiến lược giao dịch, thị trường hỗ trợ và thiết lập rủi ro.'],signals:['Tín hiệu thị trường','Lọc tín hiệu theo tài sản và trạng thái để xem dữ liệu liên quan.'],opportunities:['Cơ hội thị trường','Xem các cơ hội thị trường cùng nghiên cứu làm cơ sở cho từng nhận định.'],
  markets:['Dữ liệu thị trường','Xem giá và hoạt động thị trường của tiền mã hóa và tài sản truyền thống.'],tracking:['Theo dõi on-chain','Theo dõi hoạt động on-chain và dòng tiền tại các sàn giao dịch.'],intelligence:['Tin tức và tâm lý thị trường','Theo dõi tin thị trường và lịch kinh tế kèm nguồn tin và thời điểm công bố.'],
  social:['Xu hướng mạng xã hội','Xem bình luận thị trường, mức độ thảo luận theo chủ đề và xếp hạng nhà giao dịch.'],derivatives:['Phái sinh và thanh lý','So sánh phí funding và thanh lý theo tài sản và sàn giao dịch.'],etf:['Dòng vốn ETF','So sánh dòng vốn ETF Bitcoin và Ethereum theo từng quỹ và kỳ báo cáo.']},
 es:{
  lite:["Panel de trading Lite", "Consulta las señales de mercado y sus datos de respaldo, elige un activo y prueba una operación simulada en Lite."],
  brain:['Deep Brain','Explora el grafo de investigación de Cortexa y consulta las pruebas y notas detrás de cada observación del mercado.'],workbench:['LensWave','Consulta los datos de mercado, la verificación de fuentes y las observaciones técnicas de los activos en seguimiento.'],
  strategies:['Agentes de estrategia','Compara la lógica de las estrategias de negociación, los mercados admitidos y sus ajustes de riesgo.'],signals:['Señales de mercado','Filtra las señales por activo y estado y consulta los datos que las respaldan.'],opportunities:['Oportunidades de mercado','Consulta las oportunidades observadas y la investigación que sustenta cada una.'],
  markets:['Datos de mercado','Consulta precios y actividad de mercado de criptoactivos y activos tradicionales.'],tracking:['Seguimiento en cadena','Consulta actividad en cadena y flujos de fondos en las plataformas de intercambio.'],intelligence:['Noticias y sentimiento','Sigue las noticias de mercado y el calendario económico con sus fuentes y horas de publicación.'],
  social:['Tendencias en redes','Consulta comentarios seleccionados, actividad por tema y clasificaciones de operadores.'],derivatives:['Derivados y liquidaciones','Compara tasas de financiación y liquidaciones por activo y plataforma.'],etf:['Flujos de ETF','Compara los flujos de ETF de Bitcoin y Ethereum por fondo y periodo.']},
 fr:{
  lite:["Espace de trading Lite", "Consultez les signaux de marché et les données qui les étayent, puis simulez une opération sur l’actif de votre choix dans Lite."],
  brain:['Deep Brain','Explorez le graphe de recherche Cortexa et consultez les sources et notes associées à chaque observation de marché.'],workbench:['LensWave','Consultez les cours, les vérifications de sources et les observations techniques des actifs suivis.'],
  strategies:['Agents de stratégie','Comparez les stratégies de trading, les marchés couverts et les paramètres de risque.'],signals:['Signaux de marché','Filtrez les signaux par actif et par statut pour en consulter les données sources.'],opportunities:['Opportunités de marché','Découvrez les opportunités observées et les recherches qui les étayent.'],
  markets:['Données de marché','Consultez les cours et l’activité des cryptoactifs et des actifs traditionnels.'],tracking:['Suivi sur la blockchain','Suivez l’activité sur la blockchain et les flux de fonds des plateformes d’échange.'],intelligence:['Actualités et sentiment','Suivez les actualités de marché et le calendrier économique avec les sources et les dates de publication.'],
  social:['Tendances sociales','Consultez les commentaires sélectionnés, les sujets discutés et le classement des traders.'],derivatives:['Dérivés et liquidations','Comparez les taux de financement et les liquidations par actif et par plateforme.'],etf:['Flux des ETF','Comparez les flux des ETF Bitcoin et Ethereum par fonds et par période.']},
 ru:{
  lite:["Торговый терминал Lite", "Изучите актуальные рыночные сигналы и их обоснование, выберите актив и попробуйте учебную сделку в Lite."],
  brain:['Deep Brain','Изучайте граф исследований Cortexa, источники и заметки к рыночным наблюдениям.'],workbench:['LensWave','Следите за котировками, проверкой источников и техническими наблюдениями по выбранным активам.'],
  strategies:['Агенты стратегий','Сравнивайте логику торговых стратегий, доступные рынки и настройки риска.'],signals:['Рыночные сигналы','Отбирайте сигналы по активу и статусу и просматривайте исходные данные.'],opportunities:['Рыночные возможности','Изучайте замеченные рыночные возможности и исследования, лежащие в их основе.'],
  markets:['Рыночные данные','Просматривайте цены и динамику криптоактивов и традиционных активов.'],tracking:['Ончейн-мониторинг','Отслеживайте активность в блокчейне и движение средств на биржах.'],intelligence:['Новости и настроения','Следите за рыночными новостями и экономическим календарём с указанием источников и времени публикации.'],
  social:['Тенденции в соцсетях','Изучайте отобранные комментарии, обсуждаемые темы и рейтинги трейдеров.'],derivatives:['Деривативы и ликвидации','Сравнивайте ставки финансирования и объёмы ликвидаций по активам и биржам.'],etf:['Потоки средств ETF','Сравнивайте потоки средств в ETF на биткоин и эфир по фондам и отчётным периодам.']}
};
export const noScriptLabels={en:'Enable JavaScript to use the interactive workspace.',zh:'启用 JavaScript 即可使用交互工作区。',ja:'操作するには JavaScript を有効にしてください。',ko:'작업 공간을 이용하려면 JavaScript를 켜세요.',fr:'Activez JavaScript pour utiliser l’espace de travail interactif.',es:'Activa JavaScript para usar el espacio de trabajo interactivo.',vi:'Bật JavaScript để sử dụng không gian làm việc tương tác.',ru:'Включите JavaScript, чтобы пользоваться интерактивным интерфейсом.'};
