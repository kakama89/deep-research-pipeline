# Hướng dẫn sử dụng skill: deep-research-pipeline

> Tài liệu này tóm tắt cách dùng skill `deep-research-pipeline`. Đọc
> `SKILL.md` và các file trong `references/` để biết chi tiết đầy đủ
> (bằng tiếng Anh).

## 1. Skill này dùng để làm gì

Đây là skill nghiên cứu sâu, chia làm 9 giai đoạn, mọi kết luận trong báo
cáo đều phải truy được về nguồn (evidence ledger). Tất cả số liệu trong
báo cáo đều lấy từ `scripts/ledger.ts stats`, không được tự đếm tay. Trước
khi giao báo cáo, bước `audit --report` phải chạy thành công (exit code 0).

Dùng skill này khi:
- Cần làm literature review, tổng quan tài liệu.
- Đánh giá công nghệ / nhà cung cấp (technology, vendor evaluation).
- Khảo sát thị trường (market scan).
- Rà soát hệ thống (systematic review).
- Nghiên cứu tiêu chuẩn, quy định (standards, regulation).
- Due diligence.
- Bất kỳ câu hỏi nào mà người hỏi cần biết "kết luận này lấy từ đâu ra".

KHÔNG dùng skill này khi:
- Câu hỏi trả lời được bằng cách đọc code có sẵn (hãy đọc code trực tiếp).
- Chỉ cần tra 1 thông tin đơn giản (1 lần tìm kiếm là đủ).
- Chỉ cần xin ý kiến/quan điểm, không cần bằng chứng.

## 2. Cách gọi skill (cú pháp)

```
<chủ đề hoặc câu hỏi> [--mode quick|standard|systematic|interactive]
[--query-lang auto|<mã-ngôn-ngữ>[,<mã-ngôn-ngữ>...]] [--output-lang <mã-ngôn-ngữ>]
[--interaction-lang <mã-ngôn-ngữ>] [--from NĂM] [--sources N]
[--evidence-tier any|verified]
```

Ví dụ:
```
Nghiên cứu về tác động của AI trong giáo dục đại học --mode standard --output-lang vi
```

## 3. Các tham số

| Tham số | Giá trị | Mặc định | Ý nghĩa |
|---|---|---|---|
| `<chủ đề>` | văn bản tự do | bắt buộc | Chủ đề hoặc câu hỏi nghiên cứu |
| `--mode` | `quick`, `standard`, `systematic`, `interactive` | `standard` | Độ sâu của nghiên cứu, chỉ có 4 mức này |
| `--query-lang` | `auto` hoặc danh sách mã ISO 639, vd `vi,en` | `auto` | Ngôn ngữ dùng để TÌM KIẾM. `auto` sẽ tự đoán theo ngôn ngữ của chủ đề + tiếng Anh |
| `--output-lang` | mã ISO 639, vd `vi`, `en`, `ja` | theo ngôn ngữ người dùng | Ngôn ngữ VIẾT BÁO CÁO cuối cùng |
| `--interaction-lang` | mã ISO 639 hoặc `auto` | theo `--output-lang` | Ngôn ngữ AGENT DÙNG ĐỂ NÓI CHUYỆN với bạn (hỏi, xác nhận...), không ảnh hưởng báo cáo |
| `--from` | năm, vd `2020` | 5 năm trước | Năm xuất bản sớm nhất được chấp nhận |
| `--sources` | số nguyên | tuỳ theo mode | Ép buộc số lượng nguồn tối thiểu |
| `--evidence-tier` | `any`, `verified` | `any` | `verified`: chỉ lấy bài báo khoa học đã phản biện (có DOI), loại preprint/blog/tài liệu hãng/luận văn/bằng sáng chế/tin tức |

**Lưu ý về 3 trục ngôn ngữ (rất dễ nhầm lẫn):**
- `--query-lang`: dùng để TÌM KIẾM (có thể nhiều ngôn ngữ cùng lúc).
- `--output-lang`: ngôn ngữ của BÁO CÁO cuối cùng (chỉ 1 ngôn ngữ).
- `--interaction-lang`: ngôn ngữ agent NÓI CHUYỆN với bạn (chỉ 1 ngôn ngữ, mặc định giống `--output-lang`).

Nếu chỉ cần báo cáo và hỏi-đáp đều bằng tiếng Việt, chỉ cần đặt
`--output-lang vi` là đủ (interaction-lang sẽ tự theo).

`--evidence-tier verified` lọc rất gắt: theo đo lường thực tế, số lượng
nguồn có thể giảm từ hàng chục nghìn xuống còn vài nghìn, danh sách tham
khảo có thể giảm từ 24 xuống còn 5 nguồn dùng được. Chỉ nên bật chế độ
này ở bước "scope" (bước 1), không bật sau vì lúc đó ngân sách tìm kiếm
đã tiêu hết rồi. Phù hợp cho nghiên cứu y tế lâm sàng, pháp lý,
due-diligence; không phù hợp cho lĩnh vực thay đổi nhanh như AI/ML (vì kết
quả mới nhất thường là preprint chưa qua phản biện).

## 4. Bốn chế độ (mode)

| Mode | Dùng khi nào | Đặc điểm |
|---|---|---|
| `quick` | Muốn câu trả lời nhanh, ~10-15 nguồn | Bỏ qua khung tri thức (knowledge graph), bỏ qua bảng trích xuất, sàng lọc đơn giản |
| `standard` (mặc định) | Nghiên cứu cẩn trọng, ~25-40 nguồn | Đầy đủ 9 giai đoạn, tranh luận đa góc nhìn 2 vòng, 1 vòng Reflexion kiểm chứng |
| `systematic` | Rà soát hệ thống, chuẩn học thuật, 60+ nguồn | Đăng ký tiêu chí trước (protocol), sàng lọc 2 lần độc lập (dual-pass) + PRISMA, snowball 2 thế hệ, kiểm chứng 3 vòng |
| `interactive` | Muốn "cùng khám phá" với agent theo kiểu hỏi đáp qua lại | Chạy theo từng lượt hội thoại (roundtable), mỗi lượt là 1 "cổng" (gate) ngầm |

Nếu bạn chỉ gõ một câu hỏi ngắn gọn nhưng ý bạn muốn làm "rà soát hệ
thống" hay "khám phá cùng nhau", agent sẽ đề xuất đổi mode phù hợp tại
bước scope gate, chứ không tự ý đổi ngầm.

## 5. Quy trình 9 giai đoạn

| # | Tên giai đoạn | Làm gì | Kết quả tạo ra |
|---|---|---|---|
| 0 | Nạp trí nhớ (memory) | Đọc bài học từ các lần chạy trước, kiểm tra môi trường (`scholar.ts doctor`) | — |
| 1 | Xác định phạm vi (scope) | Mài sắc câu hỏi, viết TIÊU CHÍ trước khi tìm kiếm, xác định 3-6 góc nhìn, lập dàn ý | `00-brief.md`, `01-plan.md` — **có gate** |
| 2 | Thu thập nguồn (retrieval) | Tìm kiếm web + học thuật (OpenAlex, Semantic Scholar), "snowball" theo trích dẫn, loại trùng, đánh dấu đã đọc | `02-search-log.md`, thư mục `sources/` — **có gate** |
| 3 | Sàng lọc & trích xuất bằng chứng | Đánh giá từng nguồn theo tiêu chí, trích câu trích dẫn nguyên văn, chấm điểm bằng chứng | `03-screening.md`, `03-extraction.md` — **có gate** |
| 4 | Tổng hợp (synthesis) | Tổng hợp theo từng góc nhìn, tranh luận cho các điểm còn mâu thuẫn | `04-synthesis.md` |
| 5 | Kiểm chứng (verification) | Trả lời lại câu hỏi CHỈ dựa vào bằng chứng đã có, kiểm tra tự mâu thuẫn | `05-verification.md` |
| 6 | Sơ đồ tri thức (knowledge graph) | Vẽ thực thể và quan hệ từ các kết luận đã kiểm chứng, tìm khoảng trống | `graph.json`, `06-knowledge-graph.md` |
| 7 | Viết báo cáo | Viết theo dàn ý, trích dẫn ngay khi viết, dán bảng số liệu từ `stats --md` (không tự gõ tay) | `REPORT.md`, `gaps.md` |
| 8 | Kiểm toán (audit) | Chạy `audit --report`, phải trả về exit code 0 mới được giao báo cáo | `08-audit.md` — **có gate** |
| 9 | Vòng học hỏi (learning loop) | Hỏi 1 lần xem có gì cần ghi nhớ cho lần sau không; im lặng/không = không ghi gì cả | ghi vào `memory.md` hoặc không ghi gì |

## 6. Các "cổng" (gate) — điểm dừng lại cho bạn quyết định

Skill sẽ DỪNG LẠI và cho bạn lựa chọn (bằng số, không dùng giao diện chọn)
tại 5 điểm:

1. **scope** (hết bước 1) — xem lại câu hỏi, tiêu chí, góc nhìn, dàn ý, mode.
2. **coverage** (hết bước 2) — xem đã tìm được gì, đọc được bao nhiêu, còn thiếu gì.
3. **sufficiency** (hết bước 3) — bằng chứng đã đủ chưa, có cần tìm sâu thêm không.
4. **audit** (hết bước 8) — xem báo cáo, kết quả kiểm toán, các khoảng trống còn lại.
5. **memory** (hết bước 9) — xem trước câu sẽ được ghi nhớ, đồng ý mới ghi.

Với mode `quick`: gộp cổng 2 và 3 làm một.
Với mode `interactive`: mỗi lượt hỏi-đáp là một cổng ngầm.

## 7. Bốn nguyên tắc bắt buộc (không được phá vỡ)

1. **Đã đọc, không chỉ lướt qua.** Chỉ khi chạy lệnh `mark-read` thì nguồn
   mới được phép trích dẫn; mỗi "hit" tìm kiếm chỉ là một gợi ý (lead).
2. **Mọi kết luận phải có mã bằng chứng (evidence id), mọi con số phải có
   câu trích dẫn nguyên văn.** Nếu tóm tắt nói số liệu mà câu trích dẫn
   không có số đó, lệnh `add-evidence` sẽ từ chối (exit code 2).
3. **Không được tự đếm tay.** Mọi con số trong báo cáo phải lấy từ lệnh
   `ledger.ts stats`; lệnh `audit --report` sẽ tính lại và báo lỗi nếu phát
   hiện có ai đó sửa tay.
4. **Thà từ chối còn hơn đoán mò.** Không có bằng chứng thì không trả
   lời — ghi vào `gaps.md`, tuyệt đối không dùng kiến thức nền (background
   knowledge) để "chắp vá" cho đủ báo cáo.

## 8. Các file bắt buộc phải có khi chạy xong (ví dụ mode quick)

Tên file phải đúng chính xác, phân biệt hoa/thường (`REPORT.md` viết hoa):

```
00-brief.md
01-plan.md
02-search-log.md
03-screening.md
04-synthesis.md
05-verification.md
REPORT.md
gaps.md
08-audit.md
references-list.md
sources/S###.md   (ví dụ sources/S001.md, sources/S002.md, ...)
```

`REPORT.md` phải có dòng "Evidence current as of <ngày>" (hoặc comment
`<!-- drp:as-of YYYY-MM-DD -->`) để đánh dấu báo cáo dùng dữ liệu tính đến
ngày nào.

## 9. Cách bắt đầu chạy (kịch bản lệnh mẫu)

```bash
SKILL="<đường dẫn cài đặt skill này>"
export DRP_RUN_DIR="research/20260905-ten-chu-de-viet-tat"
bun "$SKILL/scripts/memory.ts" show              # bước 0: xem trí nhớ cũ
bun "$SKILL/scripts/scholar.ts" doctor           # bước 0: kiểm tra môi trường
mkdir -p "$DRP_RUN_DIR/sources" "$DRP_RUN_DIR/raw"
bun "$SKILL/scripts/ledger.ts" init --topic "câu hỏi đã mài sắc" --mode standard --lang vi
```

Sau khi chạy `init`, đọc tiếp:
- Nếu mode = `quick`: chỉ đọc `references/quickstart.md`, không đọc gì khác.
- Nếu mode = `standard`/`systematic`/`interactive`: đọc theo thứ tự
  `references/harness.md` → `references/00-contract.md` → `references/ledger.md`,
  rồi mới bắt đầu bước 1 (`references/01-planning.md`).

Không được bắt đầu tìm kiếm ngay khi người dùng chỉ đưa ra 1 câu hỏi sơ
sài — bước 1 (xác định phạm vi) tồn tại chính là để mài sắc câu hỏi
trước, vì câu hỏi rõ ràng thì mới biết nguồn nào là nguồn phù hợp.

## 10. Đọc thêm khi cần

| Muốn biết gì | Đọc file nào |
|---|---|
| Toàn bộ câu lệnh + 4 nguyên tắc cho mode quick | `references/quickstart.md` |
| Cách ánh xạ công cụ tìm kiếm/fetch của harness bạn đang dùng | `references/harness.md` |
| 13 quy tắc bắt buộc, cấu trúc thư mục đầu ra | `references/00-contract.md` |
| Cú pháp lệnh `ledger.ts`, mã trạng thái, cách dùng batch | `references/ledger.md` |
| Chi tiết từng bước (01 đến 09) | `references/0N-*.md` tương ứng |
| Cách xử lý khi lỗi | phần "When something goes wrong" trong `quickstart.md` |

## 11. Bảng mã lỗi thường gặp

| Mã thoát (exit code) | Ý nghĩa |
|---|---|
| 0 | Thành công |
| 1 | Lỗi, hoặc audit phát hiện vấn đề |
| 2 | **Bị từ chối có chủ đích** — không phải bug, phải sửa dữ liệu đầu vào |
| 3 | `scholar.ts fetch` không tìm thấy bản full-text (đây là 1 sự thật, không phải lỗi) |
| "no ledger at ..." | Sai đường dẫn `--dir`; chỉ cần đặt `DRP_RUN_DIR` một lần, đừng truyền lại |

Khi bị lạc không biết đang ở bước nào: chạy `bun $L state --dir $R` để xem
lại đang ở giai đoạn nào, cổng nào đã qua, còn thiếu gì.
