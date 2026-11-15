import Foundation

/// Finds a private booking link token in whatever the student pasted or opened.
/// Mirrors the server: `/b/<43 base64url characters>` followed by the end or a delimiter, or the bare token.
public enum LinkParser {
    public static let tokenLength = 43
    private static let tokenScalars = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")

    public static func token(in text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 2048 else { return nil }
        if isToken(trimmed) { return trimmed }
        var searchStart = trimmed.startIndex
        while let marker = trimmed.range(of: "/b/", range: searchStart..<trimmed.endIndex) {
            let after = trimmed[marker.upperBound...]
            let candidate = String(after.prefix(tokenLength))
            if candidate.count == tokenLength, isToken(candidate) {
                let rest = after.dropFirst(tokenLength)
                if let next = rest.first {
                    if isDelimiter(next) { return candidate }
                } else {
                    return candidate
                }
            }
            searchStart = marker.upperBound
        }
        return nil
    }

    /// For links that opened the app (universal links): https, the expected host, path exactly /b/<token>.
    public static func token(fromUniversalLink url: URL, expectedHost: String?) -> String? {
        guard url.scheme?.lowercased() == "https" else { return nil }
        if let expectedHost, url.host?.lowercased() != expectedHost.lowercased() { return nil }
        let parts = url.path.split(separator: "/", omittingEmptySubsequences: true)
        guard parts.count == 2, parts[0] == "b", isToken(String(parts[1])) else { return nil }
        return String(parts[1])
    }

    static func isToken(_ value: String) -> Bool {
        value.count == tokenLength && value.unicodeScalars.allSatisfy { tokenScalars.contains($0) }
    }

    static func isDelimiter(_ character: Character) -> Bool {
        character.isWhitespace || "/?#\"'<>),.;".contains(character)
    }
}
