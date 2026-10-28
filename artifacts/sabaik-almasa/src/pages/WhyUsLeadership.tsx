import { Navbar } from "@/components/layout/Navbar"
import { Footer } from "@/components/layout/Footer"
import { CEOMessage } from "@/components/home/CEOMessage"
import { AboutSection } from "@/components/home/AboutSection"
import { useDocumentSEO } from "@/hooks/useDocumentSEO"
import { siteUrl } from "@/lib/siteUrl"
import { Link } from "wouter"
import { ChevronLeft } from "lucide-react"
import { useSiteSettings } from "@/context/SiteSettingsContext"

export default function WhyUsLeadership() {
  const { companyName } = useSiteSettings()
  useDocumentSEO({
    title: "قيادتنا — حلول الحاويات ونقل المخلفات",
    description: "تعرّف على رؤية قيادتنا لتقديم خدمات موثوقة لتأجير الحاويات ونقل مخلفات البناء في الرياض، مع التركيز على تنظيم العمل وجودة التنفيذ.",
    keywords: `قيادة ${companyName || "المنشأة"}, رؤية المؤسسة, تأجير الحاويات بالرياض`,
    canonical: siteUrl("/why-us/leadership"),
  })

  return (
    <div className="min-h-screen flex flex-col bg-gray-50" dir="rtl">
      <Navbar />

      <div className="bg-primary text-white py-12 px-4">
        <div className="container mx-auto">
          <div className="flex items-center gap-2 text-white/60 text-sm mb-3">
            <Link href="/" className="hover:text-white transition-colors">الرئيسية</Link>
            <ChevronLeft size={14} />
            <Link href="/#about" className="hover:text-white transition-colors">لماذا نحن</Link>
            <ChevronLeft size={14} />
            <span className="text-white">القيادة</span>
          </div>
          <h1 className="text-3xl md:text-4xl font-black">قيادتنا</h1>
          <p className="text-white/70 mt-2 text-lg">رؤية وقيادة تصنع الفارق</p>
        </div>
      </div>

      <main className="flex-1">
        <CEOMessage />
        <AboutSection />
      </main>

      <Footer />
    </div>
  )
}
