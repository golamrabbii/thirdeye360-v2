// Force dynamic rendering for this API route
export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const fileId = searchParams.get("id");

    if (!fileId) {
      return new Response(JSON.stringify({ error: "Missing file ID" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Construct the Google Drive download URL
    const driveUrl = `https://drive.usercontent.google.com/download?id=${fileId}`;

    // Fetch the image from Google Drive
    const response = await fetch(driveUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; NextJS/1.0)",
      },
    });

    if (!response.ok) {
      throw new Error(`Google Drive responded with status: ${response.status}`);
    }

    // Get the image data as a buffer
    const imageBuffer = await response.arrayBuffer();

    // Return the image with appropriate headers
    return new Response(imageBuffer, {
      status: 200,
      headers: {
        "Content-Type": response.headers.get("Content-Type") || "image/jpeg",
        "Cache-Control": "public, max-age=31536000, immutable",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("Drive Proxy Error:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to fetch image from Google Drive",
        message: error.message,
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}
