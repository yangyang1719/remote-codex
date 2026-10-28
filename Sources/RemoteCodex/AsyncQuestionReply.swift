import Foundation

enum AsyncQuestionReply {
    static func encode(_ body: [String: Any]) throws -> String {
        guard let source = body["sourceItemId"] as? String, !source.isEmpty, source.utf8.count < 512,
              let index = body["questionIndex"] as? Int, (0..<100).contains(index),
              let question = body["question"] as? String, !question.isEmpty, question.utf8.count < 100_000,
              let answer = body["answer"] as? String, !answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              answer.utf8.count <= 32_000 else { throw ClientError.message("问题或回答无效，请重新打开问题卡片。") }
        let id = String(decoding: try JSONSerialization.data(withJSONObject: ["request_user_input_async", source, index], options: [.withoutEscapingSlashes]), as: UTF8.self)
        let value = [["questionItemId": id, "question": question, "answer": answer]]
        let json = String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes]), as: UTF8.self)
        return "<send_user_message_question_reply>\n" + json + "\n</send_user_message_question_reply>"
    }
}
