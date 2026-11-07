import { OWNER_ID, type DemoState, type HistoryEvent, type Member, type Output, type Task } from "./types.ts";

const MIN = 60_000;

/** Video demo xuyên suốt: ba việc (dàn ý, kịch bản…) của cùng một video chỉ được đếm là MỘT video. */
export function seedVideo(nowMs: number): DemoState["videos"][number] {
  const at = new Date(nowMs - 300 * MIN).toISOString();
  return { id: "v-1", projectId: "p-yt", title: "5 công cụ AI tiết kiệm thời gian", status: "scripting", createdAt: at, updatedAt: at };
}

/** Dữ liệu demo khởi đầu: hai dự án xuyên suốt, ba thành viên. Toàn bộ là mô phỏng. */
export function createSeed(nowMs: number): DemoState {
  const at = (minutesAgo: number) => new Date(nowMs - minutesAgo * MIN).toISOString();

  const members: Member[] = [
    {
      id: OWNER_ID,
      kind: "human",
      name: "Dong",
      avatar: "crown",
      role: "Chủ hệ thống · PM",
      description: "Chủ Dong-Lumi. Tự làm PM, tự nhận việc khi cần, quyết định điều gì đáng ghi nhớ.",
      projectIds: ["p-offer", "p-yt"],
      status: "active",
      permission: "owner",
      hermes: "connected",
      createdAt: at(60 * 24 * 30),
    },
    {
      id: "m-aff",
      kind: "bot",
      name: "Trợ lý AFF",
      avatar: "compass",
      role: "Nghiên cứu offer và quảng cáo",
      description: "Tìm và so sánh offer affiliate, soạn mẫu quảng cáo Google Search, đề xuất ghi nhớ.",
      projectIds: ["p-offer"],
      status: "active",
      permission: "assistant",
      hermes: "connected",
      profileKey: "aff",
      createdAt: at(60 * 24 * 28),
    },
    {
      id: "m-yt",
      kind: "bot",
      name: "Trợ lý YouTube",
      avatar: "clapper",
      role: "Ý tưởng và kịch bản video",
      description: "Chọn ngách, lên ý tưởng, viết dàn ý và kịch bản video cho kênh tiếng Anh.",
      projectIds: ["p-yt"],
      status: "active",
      permission: "assistant",
      hermes: "connected",
      profileKey: "yt",
      createdAt: at(60 * 24 * 28),
    },
  ];

  const ev = (
    id: string,
    minutesAgo: number,
    byId: string,
    byName: string,
    via: HistoryEvent["via"],
    kind: HistoryEvent["kind"],
    text?: string,
    version?: number,
  ): HistoryEvent => ({ id, at: at(minutesAgo), byId, byName, via, kind, ...(text ? { text } : {}), ...(version ? { version } : {}) });

  const tasks: Task[] = [
    {
      id: "DL-001",
      projectId: "p-offer",
      title: "Chọn kênh chạy thử đầu tiên cho offer",
      request: "So sánh Google Search, Facebook và YouTube Ads cho offer phần mềm năng suất ở Mỹ, đề xuất kênh thử trước.",
      outputWanted: "Đề xuất kênh kèm lý do",
      ownerId: "m-aff",
      ownerName: "Trợ lý AFF",
      source: { kind: "web", label: "Web" },
      status: "done",
      waitingConnection: false,
      createdAt: at(60 * 52),
      updatedAt: at(60 * 48),
      history: [
        ev("h-1-1", 60 * 52, OWNER_ID, "Dong", "web", "created", "Tạo việc từ web"),
        ev("h-1-2", 60 * 50, "m-aff", "Trợ lý AFF", "system", "output", "Gửi đề xuất: thử Google Search trước", 1),
        ev("h-1-3", 60 * 48, OWNER_ID, "Dong", "web", "approved", "Duyệt đề xuất, ghi quyết định", 1),
      ],
    },
    {
      id: "DL-002",
      projectId: "p-offer",
      title: "Soạn 3 mẫu quảng cáo Google Search",
      request: "Soạn 3 mẫu quảng cáo Google Search cho offer US, mỗi mẫu một góc khác nhau (tiêu đề tối đa 30 ký tự, mô tả tối đa 90).",
      outputWanted: "3 mẫu quảng cáo",
      ownerId: "m-aff",
      ownerName: "Trợ lý AFF",
      source: { kind: "telegram", label: "Telegram · AFF", chat: "aff", botName: "Trợ lý AFF" },
      status: "review",
      waitingConnection: false,
      createdAt: at(180),
      updatedAt: at(30),
      outputId: "o-2",
      history: [
        ev("h-2-1", 180, OWNER_ID, "Dong", "telegram", "created", "Tạo việc từ Telegram · AFF"),
        ev("h-2-2", 170, "m-aff", "Trợ lý AFF", "system", "started"),
        ev("h-2-3", 30, "m-aff", "Trợ lý AFF", "system", "output", "Gửi bản 1 với ba góc quảng cáo", 1),
      ],
    },
    {
      id: "DL-003",
      projectId: "p-yt",
      title: "Dàn ý video: 5 công cụ AI tiết kiệm thời gian",
      request: "Viết dàn ý video 8–10 phút cho người đi làm văn phòng ở Mỹ: mở bài, 5 công cụ, kết luận.",
      outputWanted: "Dàn ý video",
      ownerId: "m-yt",
      ownerName: "Trợ lý YouTube",
      source: { kind: "web", label: "Web" },
      status: "review",
      waitingConnection: false,
      createdAt: at(300),
      updatedAt: at(45),
      outputId: "o-3",
      videoId: "v-1",
      history: [
        ev("h-3-1", 300, OWNER_ID, "Dong", "web", "created", "Tạo việc từ web"),
        ev("h-3-2", 290, "m-yt", "Trợ lý YouTube", "system", "started"),
        ev("h-3-3", 45, "m-yt", "Trợ lý YouTube", "system", "output", "Gửi bản 1 của dàn ý", 1),
      ],
    },
    {
      id: "DL-004",
      projectId: "p-offer",
      title: "Lập kế hoạch chạy thử ngân sách nhỏ",
      request: "Đề xuất ngân sách, từ khóa và tiêu chí dừng cho đợt chạy thử Google Search đầu tiên.",
      outputWanted: "Kế hoạch chạy thử",
      ownerId: "m-aff",
      ownerName: "Trợ lý AFF",
      source: { kind: "web", label: "Web" },
      status: "ready",
      waitingConnection: false,
      createdAt: at(120),
      updatedAt: at(120),
      history: [ev("h-4-1", 120, OWNER_ID, "Dong", "web", "created", "Tạo việc từ web")],
    },
    {
      id: "DL-005",
      projectId: "p-yt",
      title: "Viết kịch bản chi tiết cho video",
      request: "Sau khi duyệt dàn ý, viết kịch bản đọc thoại và gợi ý cảnh quay.",
      outputWanted: "Kịch bản",
      videoId: "v-1",
      ownerId: "m-yt",
      ownerName: "Trợ lý YouTube",
      source: { kind: "web", label: "Web" },
      status: "new",
      waitingConnection: false,
      createdAt: at(100),
      updatedAt: at(100),
      history: [ev("h-5-1", 100, OWNER_ID, "Dong", "web", "created", "Tạo việc từ web")],
    },
  ];

  const outputs: Output[] = [
    {
      id: "o-2",
      taskId: "DL-002",
      state: "draft",
      versions: [
        {
          v: 1,
          title: "Ba mẫu quảng cáo Google Search (nội dung mẫu mô phỏng)",
          createdAt: at(30),
          sections: [
            {
              heading: "Góc 1 · Tiết kiệm thời gian",
              body: "Tiêu đề: Làm việc nhanh hơn 2 giờ/ngày\nMô tả: Phần mềm năng suất giúp bạn gom việc về một chỗ. Dùng thử miễn phí 14 ngày.",
              meta: "Nhắm: người đi làm văn phòng đang quá tải",
            },
            {
              heading: "Góc 2 · So sánh với công cụ cũ",
              body: "Tiêu đề: Thay 5 app bằng 1 công cụ\nMô tả: So sánh tính năng và giá với công cụ bạn đang dùng. Xem bảng so sánh chi tiết.",
              meta: "Nhắm: người đang dùng giải pháp rời rạc",
            },
            {
              heading: "Góc 3 · Dùng thử không rủi ro",
              body: "Tiêu đề: Dùng thử 14 ngày, hủy bất kỳ lúc nào\nMô tả: Không cần thẻ để bắt đầu. Cài trong 5 phút và xem hiệu quả ngay.",
              meta: "Nhắm: người còn ngại trả phí",
            },
          ],
        },
      ],
    },
    {
      id: "o-3",
      taskId: "DL-003",
      state: "draft",
      versions: [
        {
          v: 1,
          title: "Dàn ý video: 5 công cụ AI tiết kiệm thời gian (nội dung mẫu mô phỏng)",
          createdAt: at(45),
          sections: [
            {
              heading: "Mở bài (0:00–0:45)",
              body: "Câu hỏi móc: Bạn mất bao nhiêu giờ mỗi tuần cho việc lặp đi lặp lại? Hứa hẹn: 5 công cụ AI giúp lấy lại 2 giờ mỗi ngày, có demo thật.",
              meta: "Đối tượng: người đi làm văn phòng ở Mỹ, 25–40 tuổi, chưa rành AI",
            },
            {
              heading: "Công cụ 1–3 (0:45–5:00)",
              body: "Mỗi công cụ một tình huống: soạn email, tóm tắt cuộc họp, lọc việc ưu tiên. Mỗi phần gồm vấn đề, cách làm 30 giây, kết quả tiết kiệm được.",
            },
            {
              heading: "Công cụ 4–5 (5:00–8:30)",
              body: "Tự động hóa báo cáo và quản lý lịch. Kèm cảnh báo về dữ liệu nhạy cảm.",
            },
            {
              heading: "Kết (8:30–9:30)",
              body: "Tóm tắt bảng 5 công cụ, kêu gọi đăng ký kênh, gợi ý video tiếp theo.",
              meta: "Lý do chọn chủ đề: ít nội dung dễ hiểu dành riêng cho người mới",
            },
          ],
        },
      ],
    },
  ];

  const memories: DemoState["memories"] = [
    {
      id: "mem-d1",
      kind: "decision",
      text: "Thử Google Search trước",
      content: "Chạy thử Google Search trước. Chưa chạy Facebook hay YouTube Ads cho offer này.",
      reason:
        "Người tìm kiếm từ khóa mua hàng đã có ý định, nên biết sớm offer có chuyển đổi hay không. Ngân sách thử nhỏ (khoảng 100 USD) vẫn đo được tỷ lệ nhấp và chuyển đổi. Offer chỉ nhận traffic Mỹ/Canada, Google Search nhắm quốc gia chính xác.",
      evidence: [
        { label: "Ghi chú offer US", note: "Hoa hồng định kỳ 30% trong 12 tháng, cookie 60 ngày, chỉ Mỹ/Canada." },
        { label: "Đề xuất của Trợ lý AFF (DL-001)", note: "So sánh ba kênh, Google Search có tín hiệu ý định mạnh nhất." },
      ],
      at: at(60 * 48),
      projectId: "p-offer",
      scope: "project",
      status: "active",
      taskIds: ["DL-001"],
    },
    {
      id: "mem-d2",
      kind: "decision",
      text: "Nhắm người đi làm văn phòng ở Mỹ",
      content: "Đối tượng xem của Kênh tiếng Anh: người đi làm văn phòng ở Mỹ, 25–40 tuổi, chưa rành công cụ AI.",
      reason:
        "Nhóm này đông và ít nội dung dễ hiểu dành riêng cho họ. Ngôn ngữ đơn giản, quay không cần kiến thức sâu, dễ gắn offer phần mềm năng suất sau này.",
      evidence: [{ label: "So sánh ngách (Trợ lý YouTube)", note: "Nội dung dành cho lập trình viên đã quá đông, người mới còn thiếu." }],
      at: at(60 * 40),
      projectId: "p-yt",
      scope: "project",
      status: "active",
      taskIds: ["DL-003"],
    },
    {
      id: "mem-p1",
      kind: "rule",
      text: "Test Google Search trước",
      content: "Khi thử một offer mới trong dự án này, chạy Google Search trước (ngân sách khoảng 100 USD, xem lại sau 14 ngày), chưa chạy Facebook.",
      reason: "Rút ra từ quyết định «Thử Google Search trước». Trợ lý AFF đề xuất áp dụng cho các offer tiếp theo của dự án.",
      evidence: [
        { label: "Quyết định mem-d1", note: "Thử Google Search trước (2 ngày trước)." },
        { label: "Việc DL-002", note: "Ba mẫu quảng cáo Google Search đang chờ duyệt." },
      ],
      at: at(20),
      projectId: "p-offer",
      scope: "project",
      status: "proposed",
      taskIds: ["DL-001", "DL-002"],
      proposedBy: "m-aff",
      sourceMemoryId: "mem-d1",
    },
    {
      id: "mem-p2",
      kind: "rule",
      text: "Tiêu đề video tối đa 60 ký tự",
      content: "Tiêu đề video của Kênh tiếng Anh nên tối đa 60 ký tự, đặt từ khóa chính ở đầu.",
      reason: "Tiêu đề dài bị cắt trên điện thoại, làm giảm tỷ lệ nhấp.",
      evidence: [{ label: "Dàn ý DL-003", note: "Tiêu đề thử: 5 AI Tools That Save Me 2 Hours a Day." }],
      at: at(15),
      projectId: "p-yt",
      scope: "project",
      status: "proposed",
      taskIds: ["DL-003"],
      proposedBy: "m-yt",
      sourceMemoryId: "mem-d2",
    },
    {
      id: "mem-p3",
      kind: "rule",
      text: "Báo cáo tiếng Việt, ngắn gọn",
      content: "Luôn tóm tắt kết quả bằng tiếng Việt, tối đa 5 dòng, rồi mới đến chi tiết.",
      reason: "Chủ thường đọc nhanh trên điện thoại.",
      evidence: [{ label: "Hồ sơ Chủ", note: "Ưu tiên nhãn và báo cáo tiếng Việt dễ hiểu." }],
      at: at(10),
      scope: "personal",
      status: "proposed",
      taskIds: [],
      proposedBy: "m-aff",
    },
  ];

  const actions: DemoState["actions"] = [
    {
      id: "act-1",
      projectId: "p-offer",
      taskId: "DL-004",
      title: "Bật chiến dịch Google Search chạy thử (5 USD/ngày)",
      detail: "Mô phỏng: không có chiến dịch thật nào được tạo. Duyệt mẫu quảng cáo không bao gồm quyết định này.",
      requestedBy: "m-aff",
      at: at(25),
      status: "pending",
    },
    {
      id: "act-2",
      projectId: "p-yt",
      taskId: "DL-005",
      title: "Đăng video lên kênh YouTube (đặt lịch)",
      detail: "Mô phỏng: không có video nào được đăng. Duyệt dàn ý không bao gồm quyết định này.",
      requestedBy: "m-yt",
      at: at(18),
      status: "pending",
    },
  ];

  return {
    schema: 1,
    rev: 1,
    resetAt: new Date(nowMs).toISOString(),
    members,
    projects: [
      {
        id: "p-offer",
        name: "Test offer US",
        area: "Affiliate",
        goal: "Kiểm tra offer affiliate thị trường Mỹ: chạy thử Google Search trước, xem có lãi không.",
        pmId: OWNER_ID,
        status: "active",
      },
      {
        id: "p-yt",
        name: "Kênh tiếng Anh",
        area: "YouTube",
        goal: "Xây kênh YouTube tiếng Anh về công cụ AI giúp người đi làm văn phòng ở Mỹ làm việc nhanh hơn.",
        pmId: OWNER_ID,
        status: "active",
      },
    ],
    tasks,
    outputs,
    memories,
    actions,
    tgDrafts: [],
    tgMessages: [
      { id: "tg-1", chat: "aff", from: "bot", at: at(400), text: "Xin chào Dong, mình là Trợ lý AFF (bản mô phỏng). Gõ «Giao việc: …» hoặc /viec để giao việc." },
      { id: "tg-2", chat: "aff", from: "bot", at: at(30), card: { type: "status", taskId: "DL-002", version: 1 } },
      { id: "tg-3", chat: "yt", from: "bot", at: at(400), text: "Xin chào Dong, mình là Trợ lý YouTube (bản mô phỏng). Gõ «Giao việc: …» hoặc /viec để giao việc." },
      { id: "tg-4", chat: "yt", from: "bot", at: at(45), card: { type: "status", taskId: "DL-003", version: 1 } },
    ],
    tgAwaiting: {},
    videos: [seedVideo(nowMs)],
    adResults: [],
    seq: { task: 5, member: 3, id: 100 },
  };
}
