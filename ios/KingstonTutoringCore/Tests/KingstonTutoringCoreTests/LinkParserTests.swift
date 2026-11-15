import XCTest
@testable import KingstonTutoringCore

final class LinkParserTests: XCTestCase {
    let token = "AbcdEFGH_ijkl-MNOP0123456789qrstuvwxyzABCDE"

    func testTokenIs43Characters() {
        XCTAssertEqual(token.count, 43)
    }

    func testAcceptsTheLinkHoweverItWasPasted() {
        let link = "https://kingston-tutoring.example.workers.dev/b/\(token)"
        let variants = [
            token,
            "  \(token)\n",
            link,
            "\(link)/",
            "\(link)?utm_source=email",
            "\(link)#section",
            "Your private link: \(link) (keep it private).",
            "<\(link)>",
            "\"\(link)\"",
            link.replacingOccurrences(of: "https://", with: "http://"),
            "Line one\n\(link)\nLine three",
            "/b/\(token)",
        ]
        for text in variants {
            XCTAssertEqual(LinkParser.token(in: text), token, "variant: \(text)")
        }
    }

    func testRejectsAnythingThatIsNotALink() {
        let rejects = [
            "",
            "   ",
            "hello",
            String(token.dropLast()),
            token + "X",
            "https://x.example/b/\(token)X",
            "https://x.example/b/\(String(token.dropLast()))",
            "https://x.example/booking/\(token)",
            String(repeating: "a", count: 5000),
            "https://x.example/b/" + String(repeating: "é", count: 43),
            String(token.dropLast()) + "!",
        ]
        for text in rejects {
            XCTAssertNil(LinkParser.token(in: text), "should reject: \(text.prefix(60))")
        }
    }

    func testFindsTheValidLinkAfterAnInvalidOne() {
        let text = "Old: https://x.example/b/short and new: https://x.example/b/\(token)."
        XCTAssertEqual(LinkParser.token(in: text), token)
    }

    func testUniversalLinksMustMatchHostSchemeAndPath() {
        let host = "kingston-tutoring.example.workers.dev"
        XCTAssertEqual(LinkParser.token(fromUniversalLink: URL(string: "https://\(host)/b/\(token)")!, expectedHost: host), token)
        XCTAssertEqual(LinkParser.token(fromUniversalLink: URL(string: "https://\(host.uppercased())/b/\(token)")!, expectedHost: host), token)
        XCTAssertEqual(LinkParser.token(fromUniversalLink: URL(string: "https://\(host)/b/\(token)?x=1")!, expectedHost: host), token)
        XCTAssertNil(LinkParser.token(fromUniversalLink: URL(string: "https://evil.example/b/\(token)")!, expectedHost: host))
        XCTAssertNil(LinkParser.token(fromUniversalLink: URL(string: "http://\(host)/b/\(token)")!, expectedHost: host))
        XCTAssertNil(LinkParser.token(fromUniversalLink: URL(string: "https://\(host)/b/\(token)/extra")!, expectedHost: host))
        XCTAssertNil(LinkParser.token(fromUniversalLink: URL(string: "https://\(host)/booking/\(token)")!, expectedHost: host))
        XCTAssertNil(LinkParser.token(fromUniversalLink: URL(string: "https://\(host)/b/short")!, expectedHost: host))
    }
}
