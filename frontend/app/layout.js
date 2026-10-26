import localFont from "next/font/local";
import "./globals.css";
import ReduxProvider from "./redux/provider";
import { ThemeProvider } from "./context/ThemeContext";
import { AuthProvider } from "./context/AuthContext";
import { Toaster } from "react-hot-toast";
import ServiceWorkerRegistrar from "./components/system/ServiceWorkerRegistrar";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export const metadata = {
  title: "ThirdEye360 - Geospatial Street View & Coverage Intelligence",
  description:
    "Geospatial panoramic platform — explore 360° street coverage on an interactive map.",
};

export default function RootLayout({ children }) {
  return (
    <html lang='en' className='h-full'>
      <head>
        <link rel='preconnect' href='https://fonts.googleapis.com' />
        <link
          rel='preconnect'
          href='https://fonts.gstatic.com'
          crossOrigin='anonymous'
        />
        <link
          href='https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap'
          rel='stylesheet'
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      >
        <ThemeProvider>
          <AuthProvider>
            <ReduxProvider>{children}</ReduxProvider>
            <ServiceWorkerRegistrar />
          </AuthProvider>
          <Toaster
            position='bottom-center'
            toastOptions={{
              duration: 4000,
              success: {
                duration: 4000,
              },
              error: {
                duration: 5000,
              },
            }}
          />
        </ThemeProvider>
      </body>
    </html>
  );
}
