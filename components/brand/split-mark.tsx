/* Large, icon-only version of the Split mark, authored as two independent halves.

   The lockup logo in `logo.tsx` draws the icon as a single <path> whose `d` holds two
   subpaths. Those subpaths are the two physical pieces of the mark, so they are split
   out here into separate elements that can be transformed independently — that is what
   makes the scroll-driven split-open interaction possible with the real logo geometry
   rather than an approximation.

   Both pieces keep their flat diagonal cut edges, which face each other when closed.
   HALF_LEAD is the upper-left piece, HALF_TRAIL the lower-right. */

const GREEN = '#5FF49D'

/* Natural bounds of the icon artwork in the source pixel space. Exported because the
   split timeline sizes the mark against it: each half's drawn shape fills only part of
   this box (the rest is transparent), so anything measuring the <svg> element's rect
   is measuring empty space, not the visible green. */
export const MARK_VIEWBOX = { width: 228, height: 308 }
const VIEWBOX = `0 0 ${MARK_VIEWBOX.width} ${MARK_VIEWBOX.height}`

const HALF_LEAD =
  'M 75 2.504 C 43.432 8.896, 17.768 31.070, 6.716 61.500 C 2.551 72.967, 1.570 78.825, 1.608 92 ' +
  'C 1.660 110.496, 5.388 123.869, 15.063 140.276 C 20.543 149.568, 34.329 163.397, 43.510 168.810 ' +
  'C 50.822 173.121, 60.758 177, 64.487 177 C 66.050 177, 69.085 173.977, 75.281 166.250 ' +
  'C 80.022 160.338, 87.783 150.775, 92.528 145 C 97.273 139.225, 102.808 132.466, 104.828 129.981 ' +
  'C 110.539 122.952, 153.402 71.561, 154.021 71 C 154.324 70.725, 161.141 62.850, 169.169 53.500 ' +
  'C 177.197 44.150, 187.181 32.681, 191.355 28.014 C 199.107 19.347, 200.639 16.185, 199.531 11.141 ' +
  'C 198.796 7.794, 194.684 3.575, 190.685 2.064 C 186.313 0.412, 83.397 0.804, 75 2.504 Z'

const HALF_TRAIL =
  'M 148.855 123.226 C 140.960 133.251, 133.306 143.039, 131.847 144.976 ' +
  'C 130.388 146.914, 116.516 164.475, 101.021 184 C 23.023 282.283, 24.122 280.862, 22.860 285.073 ' +
  'C 20.644 292.468, 24.304 300.658, 31.500 304.413 C 35.304 306.398, 37.265 306.515, 71.500 306.805 ' +
  'C 125.914 307.265, 138.635 305.380, 162.500 293.317 C 183.371 282.768, 203.099 262.970, 214.247 241.386 ' +
  'C 221.733 226.890, 225.549 214.225, 226.992 199.086 C 228.795 180.165, 225.392 161.421, 217.264 145.500 ' +
  'C 208.198 127.742, 191.668 112.278, 176.168 107.057 C 164.280 103.052, 165.148 102.538, 148.855 123.226 Z'

interface SplitMarkProps {
  className?: string
}

/* Each half is its own <svg>, both sharing the same viewBox and stacked at inset:0.
   Because the two halves keep their original coordinates inside a common coordinate
   space, the untransformed state reassembles into the exact source logo — while each
   half remains a separate element that can be translated and scaled on its own.
   Decorative: the nav wordmark already names the brand to assistive tech. */
export function SplitMark({ className }: SplitMarkProps) {
  return (
    <div className={className} aria-hidden="true">
      <svg className="sp-mark-half sp-mark-lead" viewBox={VIEWBOX} fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d={HALF_LEAD} fill={GREEN} />
      </svg>
      <svg className="sp-mark-half sp-mark-trail" viewBox={VIEWBOX} fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d={HALF_TRAIL} fill={GREEN} />
      </svg>
    </div>
  )
}
