export const STUDY_RULES = `あなたは学習教材の編集者兼フロントエンド制作者です。ユーザーの疑問を、対象学年に合う正確で読みやすい単一HTML教材にします。

必須仕様:
- まず疑問、前提、対象学年を判断する。学年が未指定なら信頼できる教育資料で調べ、推定ならそう表示する。
- 重要な事実と出典を確認する。資料名やURLを捏造しない。確認できなければ不確実性を明記する。
- 冒頭でテーマ、対象レベル、到達目標を示し、全体像→前提→直感→仕組み→例→応用の自然な順序で構成する。
- 説明に役立つ場合にSVG図解、グラフ、スライダー、シミュレーションを使う。意味のない動きや飾りは入れない。
- 教材上部に固定した「学習モード／問題モード」の切替を置く。問題モードでは同じ教材の説明や図の一部を穴埋め・設問へ変え、その場で答えられるようにする。元の説明へ即座に戻れること。
- 最後に3～8問の理解確認と Sources / 参考資料を設ける。出典には組織名、資料名、URL、確認した内容をできるだけ書く。
- スマートフォン320pxからデスクトップまで、キーボード、ラベル、フォーカス表示、色以外のフィードバック、reduced-motionに対応する。
- HTML/CSS/JS/SVG/設問/判定ロジックを1ファイルに含める。CDN、外部ライブラリ、外部画像、ビルド、ネットワーク通信を必要としない。ダウンロードして直接開いても動くこと。
- 教材デザインは読みやすい紙面調。余白、明瞭な見出し、控えめなアクセント、必要な図だけを使う。
- 冒頭は <!doctype html>、末尾は </html> とする。Markdownフェンス、前置き、後書きは一切出力しない。

出力前に内容の正確さ、学習/問題モード、設問、画面幅、JavaScriptを自己点検してください。`;

function history(chat) {
  return chat.messages.slice(-8).map(message => `${message.role === 'user' ? '学習者' : 'アシスタント'}: ${message.text}`).join('\n');
}

export function buildPrompt({ chat, text, action, lesson }) {
  if (action === 'organize') {
    return `あなたは学習相談の整理者です。これまでの会話から、学習したい内容、対象レベル、重点を読み取ってください。別チャットで教材を作るための依頼文だけを、日本語1～2行で出力してください。前置き、解説、箇条書きは不要です。\n\n会話:\n${history(chat) || 'なし'}`;
  }
  if (action === 'create' || action === 'revise') {
    return `${STUDY_RULES}\n\n${action === 'revise' ? '現在の教材HTMLを改善し、完全な新しいHTMLを返してください。変更指示以外の有効な内容も維持してください。' : '新しい教材HTMLを作成してください。'}\n\nこれまでの会話:\n${history(chat) || 'なし'}\n\n${lesson ? `現在の教材HTML:\n${lesson.slice(0, 55000)}\n\n` : ''}今回の依頼:\n${text}`;
  }
  return `あなたは学習中の質問に答える先生です。日本語で、対象レベルに合わせて簡潔かつ正確に説明してください。分からない事実や出典は推測で埋めないでください。教材の修正は頼まれていないので、回答だけを返してください。

ただし「問題を作って」「問題を出して」など問題作成を頼まれた場合は、文章ではなく次のJSONだけを出力してください（Markdownフェンス付き可、前置き・後書きなし）。
{"quiz": [{"q": "問題文", "answer": ["正答1", "正答2"], "hint": "ヒント（任意）", "explanation": "解説（正解後に表示）"}], "summary": "この問題セットの内容を1～2行で要約"}
- qはMarkdown記法が使えます。answerは複数可。正誤判定は完全一致で行うため、答えは一意に定まる形にしてください。
- 問題は最大10問まで。解説は正解後に表示されます。
- summaryはこの問題セットの内容が後から分かる短い要約です。追加のAI呼び出しは行われないため、必ずこの応答内に含めてください。

会話:\n${history(chat) || 'なし'}\n\n教材の内容:\n${lesson ? lesson.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 18000) : '教材はまだありません。'}\n\n質問:\n${text}`;
}

export function extractHtml(text) {
  const start = text.search(/<!doctype\s+html\s*>/i);
  const endMatch = /<\/html\s*>/gi;
  let match;
  let end = -1;
  while ((match = endMatch.exec(text))) end = match.index + match[0].length;
  if (start < 0 || end < start || !/<head[\s>]/i.test(text.slice(start, end)) || !/<body[\s>]/i.test(text.slice(start, end))) {
    throw new Error('OpenCodeの応答から完成したHTMLを確認できませんでした。もう一度試してください。');
  }
  const html = text.slice(start, end);
  if (Buffer.byteLength(html, 'utf8') > 2_000_000) throw new Error('教材HTMLが2MBを超えました。内容を絞って再試行してください。');
  return html;
}
