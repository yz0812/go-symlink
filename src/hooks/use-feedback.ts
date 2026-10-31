import { useCallback, useEffect, useRef, useState } from 'react'

export type FeedbackTone = 'success' | 'error' | 'destructive'

export interface Feedback {
  id: number
  title: string
  message: string
  tone: FeedbackTone
}

export type ShowFeedback = (title: string, message: string, tone: FeedbackTone) => void

/** 居中的操作结果提示：成功类 1 秒后自动淡出，错误类需要手动关闭 */
export function useFeedback() {
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [closing, setClosing] = useState(false)
  const idRef = useRef(0)

  useEffect(() => {
    if (!feedback || feedback.tone === 'error') {
      return
    }

    const timer = window.setTimeout(() => setClosing(true), 1000)
    return () => window.clearTimeout(timer)
  }, [feedback])

  useEffect(() => {
    if (!closing || !feedback) {
      return
    }

    const closingId = feedback.id
    const timer = window.setTimeout(() => {
      setFeedback((current) => (current?.id === closingId ? null : current))
      setClosing(false)
    }, 160)

    return () => window.clearTimeout(timer)
  }, [closing, feedback])

  const show = useCallback<ShowFeedback>((title, message, tone) => {
    idRef.current += 1
    setClosing(false)
    setFeedback({ id: idRef.current, title, message, tone })
  }, [])

  const hide = useCallback(() => setClosing(true), [])

  return { feedback, closing, show, hide }
}
